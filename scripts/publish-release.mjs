#!/usr/bin/env node
/**
 * 转发到用户级技能 release-uploader（~/.workbuddy/skills/release-uploader）。
 * 技能负责「<远端根>/<项目>/<版本>/」布局上传 Cloudreve WebDAV + manifest + 链接，
 * 这层包装只做两件事：定位技能脚本、把工作目录切回仓库根。
 *
 * 用法与参数见技能 SKILL.md（npm run publish:artifact / release:check / release）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(os.homedir(), '.workbuddy', 'skills', 'release-uploader', 'scripts', 'publish-release.mjs');

if (!fs.existsSync(SKILL)) {
  console.error(
    '✗ 未找到 release-uploader 技能脚本:\n' +
      `  ${SKILL}\n` +
      '  重新安装技能，或改用仓库里的 git 历史版本 scripts/publish-cloudreve.mjs（已删除）。'
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, [SKILL, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
});
process.exit(res.status ?? 1);
