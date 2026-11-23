import express, { type Request, type Response } from "express";
import {
  recordId,
  workspace,
  WorkspaceError,
  type DescribeCache,
  type SalesforceWrite
} from "./workspace";
import { parseAction, performAction, recommendations } from "./actions";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

const origin = "http://localhost:5173";
const callback = origin + "/auth/callback";
const cookie = "rep_session";
const login = new URL(
  process.env.SF_LOGIN_URL || "https://login.salesforce.com"
);
if (
  login.protocol !== "https:" ||
  !/^(login\.salesforce\.com|[\w.-]+\.my\.salesforce\.com)$/.test(
    login.hostname
  ) ||
  login.origin !== login.href.slice(0, -1)
) {
  throw new Error(
    "SF_LOGIN_URL must be a Salesforce login or My Domain origin."
  );
}

type Tokens = {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
};
type Session = Tokens & {
  expires: number;
  refreshing?: Promise<boolean>;
  fields: DescribeCache;
  profile?: { userId: string; username: string };
};
export function createApp({
  transport = fetch,
  clientId = process.env.SF_CLIENT_ID,
  clientSecret = process.env.SF_CLIENT_SECRET,
  now = Date.now
}: {
  transport?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
} = {}) {
  const pending = new Map<
    string,
    { state: string; verifier: string; expires: number; consumed?: boolean }
  >();
  const sessions = new Map<string, Session>();
  const random = () => randomBytes(32).toString("base64url");
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/" };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.get("host") !== "localhost:5173") {
      res.sendStatus(421);
      return;
    }
    res.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
    });
    if (req.path.startsWith("/auth/") || req.path.startsWith("/api/"))
      res.set("Cache-Control", "no-store");
    next();
  });

  function readCookie(header: string | undefined, name: string) {
    return (
      header
        ?.split(/;\s*/)
        .find((part) => part.startsWith(name + "="))
        ?.slice(name.length + 1) ?? ""
    );
  }

  async function exchange(params: Record<string, string>): Promise<Tokens> {
    const unavailable = () =>
      new WorkspaceError(
        503,
        "Salesforce sign-in is temporarily unavailable. Try again."
      );
    const response = await transport(new URL("/services/oauth2/token", login), {
      method: "POST",
      body: new URLSearchParams({
        ...params,
        client_id: clientId!,
        client_secret: clientSecret!
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "error"
    }).catch(() => {
      throw unavailable();
    });
    if (!response.ok) {
      const reason = await response.json().catch(() => null);
      if (reason?.error === "invalid_grant" && response.status === 400)
        throw new WorkspaceError(
          401,
          "Your Salesforce session expired. Sign in again."
        );
      throw unavailable();
    }
    const tokens: Tokens = await response.json();
    const instance = new URL(tokens.instance_url);
    if (
      instance.protocol !== "https:" ||
      !instance.hostname.endsWith(".salesforce.com") ||
      instance.username ||
      instance.password ||
      instance.port ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token
    ) {
      throw new Error("Invalid Salesforce token response");
    }
    return {
      access_token: tokens.access_token,
      instance_url: instance.origin,
      refresh_token:
        typeof tokens.refresh_token === "string"
          ? tokens.refresh_token
          : undefined
    };
  }

  app.get("/auth/login", (_req, res) => {
    if (!clientId || !clientSecret) {
      res
        .status(503)
        .send(
          "Configure SF_CLIENT_ID and SF_CLIENT_SECRET in the local environment, then restart."
        );
      return;
    }
    const id = random();
    const state = random();
    const verifier = random();
    pending.delete(readCookie(_req.headers.cookie, "rep_oauth"));
    pending.set(id, { state, verifier, expires: now() + 600_000 });
    res.cookie("rep_oauth", id, { ...cookieOptions, maxAge: 600_000 });
    const authorize = new URL("/services/oauth2/authorize", login);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      scope: "api refresh_token openid",
      state,
      prompt: "login",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256"
    }).toString();
    res.redirect(authorize.href);
  });

  app.get("/auth/callback", async (req, res) => {
    const id = readCookie(req.headers.cookie, "rep_oauth");
    const attempt = pending.get(id);
    if (
      !attempt ||
      attempt.consumed ||
      attempt.expires <= now() ||
      req.query.state !== attempt.state ||
      typeof req.query.code !== "string"
    ) {
      res.redirect("/?error=oauth");
      return;
    }
    try {
      attempt.consumed = true;
      const tokens = await exchange({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: callback,
        code_verifier: attempt.verifier
      });
      if (pending.get(id) !== attempt || attempt.expires <= now()) {
        res.redirect("/?error=oauth");
        return;
      }
      res.clearCookie("rep_oauth", cookieOptions);
      sessions.delete(readCookie(req.headers.cookie, cookie));
      const sessionId = random();
      const maxAge = 8 * 60 * 60 * 1000;
      sessions.set(sessionId, {
        ...tokens,
        expires: now() + maxAge,
        fields: new Map()
      });
      res.cookie(cookie, sessionId, { ...cookieOptions, maxAge }).redirect("/");
    } catch {
      res.redirect("/?error=oauth");
    } finally {
      pending.delete(id);
    }
  });

  async function salesforce(
    session: Session,
    path: string,
    isActive: () => boolean,
    write?: SalesforceWrite
  ) {
    const request = () => {
      if (!isActive())
        throw new WorkspaceError(
          401,
          "Your Salesforce session expired. Sign in again."
        );
      const target = new URL(path, session.instance_url);
      if (target.origin !== session.instance_url)
        throw new WorkspaceError(
          502,
          "Salesforce returned an invalid request target."
        );
      return transport(target, {
        method: write?.method,
        headers: {
          Authorization: "Bearer " + session.access_token,
          ...(write ? { "Content-Type": "application/json" } : {})
        },
        body: write ? JSON.stringify(write.body) : undefined,
        signal: AbortSignal.timeout(15000),
        redirect: "error"
      });
    };
    const token = session.access_token;
    const response = await request();
    if (response.status !== 401 || !session.refresh_token) return response;
    if (token !== session.access_token) return request();
    session.refreshing ??= exchange({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token
    })
      .then((tokens) => {
        Object.assign(session, {
          ...tokens,
          refresh_token: tokens.refresh_token ?? session.refresh_token
        });
        session.fields.clear();
        return true;
      })
      .catch((error) => {
        if (error instanceof WorkspaceError && error.status === 401)
          return false;
        throw new WorkspaceError(
          503,
          "Salesforce could not refresh the session. Try again."
        );
      })
      .finally(() => {
        delete session.refreshing;
      });
    return (await session.refreshing) ? request() : response;
  }

  function readRoute(
    handler: (
      req: Request,
      service: ReturnType<typeof workspace>,
      session: Session
    ) => Promise<unknown>
  ) {
    return async (req: Request, res: Response) => {
      const id = readCookie(req.headers.cookie, cookie);
      const session = sessions.get(id);
      if (!session || session.expires <= now()) {
        sessions.delete(id);
        if (session) res.clearCookie(cookie, cookieOptions);
        res.sendStatus(401);
        return;
      }
      try {
        const isActive = () =>
          sessions.get(id) === session && session.expires > now();
        const result = await handler(
          req,
          workspace(
            (path, write) => salesforce(session, path, isActive, write),
            session.fields
          ),
          session
        );
        if (!isActive()) {
          res.sendStatus(401);
          return;
        }
        res.json(result);
      } catch (error) {
        if (sessions.get(id) !== session) {
          res.sendStatus(401);
          return;
        }
        if (error instanceof WorkspaceError && error.status === 401) {
          sessions.delete(id);
          res.clearCookie(cookie, cookieOptions);
        }
        res.status(error instanceof WorkspaceError ? error.status : 502).json({
          error:
            error instanceof WorkspaceError
              ? error.message
              : "Salesforce is temporarily unavailable.",
          uncertain: error instanceof WorkspaceError && error.uncertain
        });
      }
    };
  }

  async function profile(
    service: ReturnType<typeof workspace>,
    session: Session
  ) {
    if (!session.profile) {
      const identity = await service.get<{
        user_id?: string;
        sub?: string;
        preferred_username?: string;
        name?: string;
      }>("/services/oauth2/userinfo");
      const userId = identity.user_id ?? identity.sub?.split("/").at(-1);
      if (!recordId(userId))
        throw new WorkspaceError(
          502,
          "Salesforce did not identify the signed-in user."
        );
      session.profile = {
        userId,
        username:
          identity.preferred_username ?? identity.name ?? "Salesforce user"
      };
    }
    return session.profile;
  }

  const today = () => new Date(now()).toISOString().slice(0, 10);
  app.get(
    "/api/session",
    readRoute(async (_req, service, session) => {
      return { username: (await profile(service, session)).username };
    })
  );
  app.get(
    "/api/pipeline",
    readRoute(async (_req, service, session) => {
      return service.pipeline(
        (await profile(service, session)).userId,
        today()
      );
    })
  );
  app.get(
    "/api/accounts/:id",
    readRoute(async (req, service, session) => {
      if (!recordId(req.params.id))
        throw new WorkspaceError(400, "Invalid account.");
      const selected = req.query.opportunity;
      if (selected !== undefined && !recordId(selected))
        throw new WorkspaceError(400, "Invalid opportunity.");
      const user = await profile(service, session);
      await service.requireOpenOpportunity(
        user.userId,
        req.params.id,
        selected
      );
      const snapshot = await service.snapshot(req.params.id, today(), selected);
      return {
        ...snapshot,
        actions: selected
          ? await recommendations(service, snapshot, selected)
          : undefined
      };
    })
  );

  app.post(
    "/api/actions",
    (req, res, next) => {
      if (req.get("origin") !== origin) {
        res.sendStatus(403);
        return;
      }
      if (!req.is("application/json")) {
        res.sendStatus(415);
        return;
      }
      express.json({ limit: "4kb" })(req, res, (error) => {
        if (error) {
          res
            .status(error.status === 413 ? 413 : 400)
            .json({ error: "Invalid action request." });
          return;
        }
        next();
      });
    },
    readRoute(async (req, service, session) => {
      const action = parseAction(req.body, today());
      return performAction(
        service,
        (await profile(service, session)).userId,
        action
      );
    })
  );

  app.post("/auth/logout", (req, res) => {
    if (req.get("origin") !== origin) {
      res.sendStatus(403);
      return;
    }
    sessions.delete(readCookie(req.headers.cookie, cookie));
    pending.delete(readCookie(req.headers.cookie, "rep_oauth"));
    res.clearCookie("rep_oauth", cookieOptions);
    res.clearCookie(cookie, cookieOptions).sendStatus(204);
  });

  app.use(express.static(resolve("dist")));
  setInterval(() => {
    const time = now();
    for (const [id, entry] of pending)
      if (entry.expires <= time) pending.delete(id);
    for (const [id, entry] of sessions)
      if (entry.expires <= time) sessions.delete(id);
  }, 60_000).unref();
  return app;
}

export const app = createApp();
