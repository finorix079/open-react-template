import fs from "fs/promises";
import path from "path";

export async function appendLogLine(
  line: string,
  filePath: string = "logs/tool_calls.log",
): Promise<void> {
  try {
    const dir = path.dirname(filePath);

    // ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // append line (creates file if not exists)
    await fs.appendFile(filePath, new Date().toISOString() + ' - ' + line + "\n", "utf8");
  } catch (error) {
    console.error("Failed to write log:", error);
    throw error;
  }
}