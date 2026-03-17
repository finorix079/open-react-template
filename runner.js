const { parentPort, workerData } = require('worker_threads');
const { pathToFileURL } = require('url');
const path = require('path');

(async () => {
  try {
    const url = workerData.url;
    console.log(`Worker processing: ${url}`);

    // Simulate clearing cache or other operations
    const resolvedPath = pathToFileURL(path.resolve(url)).href;
    console.log(`Resolved path: ${resolvedPath}`);

    // Notify parent that the task is complete
    parentPort.postMessage(`Cache cleared for ${url}`);
  } catch (error) {
    console.error(`Worker encountered an error:`, error);
    parentPort.postMessage(`Error: ${error.message}`);
  }
})();