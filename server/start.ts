import { app } from "./index";

app.listen(5173, "localhost", (error) => {
  if (error) {
    console.error("Could not start Rep Workspace: " + error.message);
    process.exitCode = 1;
    return;
  }
  console.log("Rep Workspace: http://localhost:5173");
});
