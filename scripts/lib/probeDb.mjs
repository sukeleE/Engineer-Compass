// 探针/冒烟脚本直连 SQLite 的唯一入口。**为什么必须走这里**：
//
// 这类脚本的夹具 id（uidA/uidB）来自它们所打的那个 API 后端，而自清理是直连 compass.db。
// 两边一旦不同源就会出事：脚本改成对着临时实例跑（PROBE_API / PORT 换掉），id 属于临时库，
// 清理却去删默认库里**同号**的用户 —— 而 user 的从表大多是 ON DELETE CASCADE，
// 删除会静默成功，连带清掉那个人的帖子/评论/日程，不留痕迹、不可恢复。
// （2026-09-10 真实发生过：探针指着临时库跑，删掉了真实库 id 1、2 的用户行，无备份。）
//
// 闸门就是一句话：**库必须属于你打的那个后端**。默认（本机 :3000 ↔ 默认库）两边同源，放行；
// 只要 API 基址不是默认那个，就必须显式给 PROBE_DB 指明同一个实例的库，否则拒绝连接。
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_API = 'http://localhost:3000/api';
export const DEFAULT_DB = 'D:\\desktop\\竞赛指导\\backend\\data\\compass.db';

// 注意：库路径只认 PROBE_DB，**绝不跟着 PROBE_API 自动推导** —— 推导一旦猜错就是静默误删。
export function openProbeDb(apiBase) {
  const api = apiBase || DEFAULT_API;
  if (api !== DEFAULT_API && !process.env.PROBE_DB) {
    throw new Error(
      `拒绝直连 DB：脚本打的是 ${api}（非默认 ${DEFAULT_API}），库路径却还是默认库。\n` +
      '  夹具 id/邮箱属于那个后端，删默认库会误删真实用户（级联且静默）。\n' +
      '  确需清理请一并给 PROBE_DB=<该实例的库路径>；不需要清理就别连库。'
    );
  }
  return new DatabaseSync(process.env.PROBE_DB || DEFAULT_DB);
}
