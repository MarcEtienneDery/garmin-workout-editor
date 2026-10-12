// Side-effect module: must be the first import of the server entry point so
// that nothing written during module load can reach stdout.
import { installConsoleRedirect } from "./logCapture";

installConsoleRedirect();
