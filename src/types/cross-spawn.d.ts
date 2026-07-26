declare module "cross-spawn" {
  import { spawn } from "node:child_process";

  const crossSpawn: typeof spawn;
  export default crossSpawn;
}
