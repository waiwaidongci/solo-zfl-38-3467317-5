import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// 某些环境无法用 root 安装 chromium 的系统依赖；scripts/fetch-browser-libs.sh
// 会把依赖库解包到本地目录，这里把其中的库目录加入 LD_LIBRARY_PATH。
function configureLibPath() {
  const roots = [process.env.CHROME_LIBS, "/tmp/chromelibs"].filter(Boolean);
  const dirs = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = d => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, name.name);
        if (name.isDirectory()) {
          if (name.name.endsWith("-linux-gnu") || name.name === "lib" || name.name === "arm-linux-gnueabihf") dirs.push(p);
          walk(p);
        }
      }
    };
    walk(root);
  }
  if (dirs.length) {
    process.env.LD_LIBRARY_PATH = [...dirs, process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
  }
}

export async function launchBrowser() {
  configureLibPath();
  return chromium.launch();
}
