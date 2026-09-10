// 探针用的「假 Gitee」：一个本地 http 服务，同时扮 API（/api/v5/...）与裸文件域（/raw/...）。
//
// 为什么要有它：真 gitee.com 匿名配额约 60 次/小时/IP，且内容随时会变 —— 探针跑两次就可能红。
// 后端用 GITEE_BASE_URL / GITEE_RAW_BASE 两个环境变量指过来（同 VISION_BASE_URL 的先例），
// 于是 Gitee 这条链路可以**离线、确定性**地测：树长什么样、限流怎么报、代理取文件对不对。
//
// 固定夹具（owner 一律 probe-owner，repo 语义见下）：
//   demo    正常仓库：3 层目录 + 4 个文件，含一个中文名文件
//   missing 404（仓库/分支不存在）
//   flood   403（限流）
//   big     truncated=1（超出接口上限）
// 其余 repo 一律按 demo 返回，省得每加一个断言就改一次夹具。
import { createServer } from 'node:http';

export const OWNER = 'probe-owner';

// 内容表：path → { body, type }
export const BLOBS = {
  'README.md': { body: '# 假仓库说明\n\n来自探针的假 Gitee，不是真仓库。\n', type: 'text/markdown' },
  'src/main.js': { body: 'console.log("假仓库深层文件");\n', type: 'text/javascript' },
  'src/util/中文名.txt': { body: '中文文件名与中文内容都要活下来\n', type: 'text/plain' },
  'assets/pic.png': { body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), type: 'image/png' },
};

// 树条目顺序刻意打乱（真实 API 也不保证有序），让「前端自己排序」这件事被真的测到
export const TREE = [
  { path: 'src/util/中文名.txt', mode: '100644', type: 'blob', size: BLOBS['src/util/中文名.txt'].body.length },
  { path: 'README.md', mode: '100644', type: 'blob', size: Buffer.byteLength(BLOBS['README.md'].body) },
  { path: 'assets', mode: '040000', type: 'tree', size: 0 },
  { path: 'src/main.js', mode: '100644', type: 'blob', size: Buffer.byteLength(BLOBS['src/main.js'].body) },
  { path: 'src', mode: '040000', type: 'tree', size: 0 },
  { path: 'assets/pic.png', mode: '100644', type: 'blob', size: BLOBS['assets/pic.png'].body.length },
  { path: 'src/util', mode: '040000', type: 'tree', size: 0 },
];

// 被请求过的 raw 路径（探针用它断言「代理只走后端、浏览器没直连 Gitee」）
export const hits = { tree: 0, raw: [], lastRef: '' };

export function startFakeGitee(port) {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = decodeURIComponent(url.pathname);
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };

    // API：GET /api/v5/repos/{owner}/{repo}/git/trees/{ref}?recursive=1
    const m = p.match(/^\/api\/v5\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/);
    if (m) {
      const [, owner, repo, ref] = m;
      hits.tree++;
      hits.lastRef = ref;
      if (owner !== OWNER) return send(404, JSON.stringify({ message: '仓库不存在' }));
      if (repo === 'missing') return send(404, JSON.stringify({ message: '仓库不存在' }));
      if (repo === 'flood') return send(403, JSON.stringify({ message: 'rate limit' }));
      if (repo === 'big') return send(200, JSON.stringify({ tree: TREE, truncated: true }));
      return send(200, JSON.stringify({ tree: TREE, truncated: false }));
    }

    // 裸文件：GET /{owner}/{repo}/raw/{ref}/{path...}
    const r = p.match(/^\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/);
    if (r) {
      const [, , repo, ref, path] = r;
      hits.raw.push(path);
      const b = BLOBS[path];
      if (!b) return send(404, 'not found', 'text/plain');
      return send(200, b.body, b.type);
    }

    send(404, JSON.stringify({ error: '假 Gitee：没有这个路径', path: p }));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

export const apiBaseOf = (port) => `http://127.0.0.1:${port}/api/v5`;
export const rawBaseOf = (port) => `http://127.0.0.1:${port}`;
