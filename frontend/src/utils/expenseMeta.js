// 报销整理·分类元数据（前端镜像副本）
// ⚠️ 与后端 backend/lib/expenseMeta.js 保持同步 —— 改本文件必须同步改后端，反之亦然
// row.data 的 JSON 键使用中文（与 Excel 列名同源）；金额存 JSON number；是/否为三态 ''|'是'|'否'
export const CATEGORIES = [
  { key: 'reg', zh: '报名费', num: '①', folder: '01报名费', sumKey: '金额' },
  { key: 'train', zh: '车票', num: '②', folder: '02车票', sumKey: '金额' },
  { key: 'hotel', zh: '住宿', num: '③', folder: '03住宿', sumKey: '实付金额' },
  { key: 'mail', zh: '邮寄费', num: '④', folder: '04邮寄费', sumKey: '金额' },
  { key: 'prop', zh: '耗材道具', num: '⑤', folder: '05耗材道具', sumKey: '金额' },
  // ⑥零散票据（2026-09-03）：含多人/跨队的一张票据文件，仅"全项目统一支付"区可录（队行 misc 400）
  { key: 'misc', zh: '零散票据', num: '⑥', folder: '06零散票据', sumKey: '金额' },
];
export const catMeta = (cat) => CATEGORIES.find((c) => c.key === cat);

// 字段定义（type: text | money | yn | textarea | date | multi；text 默认 ≤40 字，max 可覆盖）
// 2026-09-03 下午：帮付三件套（是否帮付/帮付人/车票是否已付款）全部场景删除 —— 帮谁付由
// 「统一支付范围」表达（涵盖的人）；行归属=出钱人口径保留
export const FIELDS = {
  reg: [
    { key: '金额', label: '金额(元)', type: 'money' },
    { key: '备注', label: '备注', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
  train: [
    // 起止日期：日历选择、精确到日（键保留旧"时间"名以便存量数据原样展示；label/type 为日历）
    { key: '出发时间', label: '出发日期', type: 'date' },
    { key: '到达时间', label: '到达日期', type: 'date' },
    { key: '出发地', label: '出发地', type: 'text' },
    { key: '到达地', label: '到达地', type: 'text' },
    { key: '座位等级', label: '座位等级', type: 'text', placeholder: '如 二等座' },
    { key: '金额', label: '金额(元)', type: 'money' },
    { key: '备注', label: '备注', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
  hotel: [
    { key: '酒店名称', label: '酒店名称', type: 'text' },
    { key: '房号', label: '房号', type: 'text' },
    { key: '入住日期', label: '入住日期', type: 'date' },
    { key: '退房日期', label: '退房日期', type: 'date' },
    { key: '实付金额', label: '实付金额(元)', type: 'money' },
    { key: '备注', label: '备注', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
  mail: [
    { key: '金额', label: '金额(元)', type: 'money' },
    { key: '备注', label: '备注(用途/单号可写此处)', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
  prop: [
    { key: '购买人', label: '购买人', type: 'text', max: 20, placeholder: '姓名或”队伍”' },
    { key: '物品名称', label: '物品名称', type: 'text', max: 50 },
    { key: '金额', label: '金额(元)', type: 'money' },
    { key: '是否日常家用', label: '是否日常/家用物品', type: 'yn' },
    { key: '备注', label: '备注(用途/使用场合)', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
  // 零散票据：命名+金额(选填)+备注+涵盖的人（勾选或整个项目全体）；附件=票据文件本身
  misc: [
    { key: '票据名称', label: '票据名称', type: 'text', max: 60, placeholder: '如：7-20 打车发票×3、报名缴费凭证' },
    { key: '金额', label: '金额(元)', type: 'money' },
    { key: '备注', label: '备注', type: 'textarea' },
    { key: '统一支付范围', label: '统一支付范围', type: 'multi', max: 200 },
  ],
};

// 附件槽位（ASCII 键存 DB/URL/目录；label 仅在展示层出现）
export const SLOTS = {
  reg: [
    { key: 'invoice', label: '发票(PDF)' },
    { key: 'invoiceCheck', label: '发票查验(PDF)' },
    { key: 'payProof', label: '付款凭证(截图)' },
  ],
  train: [
    { key: 'invoice', label: '发票(PDF)' },
    { key: 'payProof', label: '付款凭证(截图)' },
  ],
  hotel: [
    { key: 'invoice', label: '发票(PDF)' },
    { key: 'invoiceCheck', label: '发票查验(PDF)' },
    { key: 'lodgingList', label: '住宿清单(图)' },
    { key: 'payProof', label: '付款凭证(截图)' },
  ],
  mail: [
    { key: 'invoice', label: '发票(PDF)' },
    { key: 'invoiceCheck', label: '发票查验(PDF)' },
    { key: 'waybill', label: '运单(截图/单号)' },
    { key: 'paymentProof', label: '支付凭证(截图)' },
  ],
  prop: [
    { key: 'invoice', label: '发票(PDF)' },
    { key: 'invoiceCheck', label: '发票查验(PDF)' },
    { key: 'orderShot', label: '订单界面(截图)' },
    { key: 'usagePhoto', label: '项目使用图(照片)' },
  ],
  misc: [
    { key: 'ticket', label: '票据/凭证(图或PDF)' },
  ],
};

export const YN_VALUES = ['', '是', '否'];

export function slotLabel(cat, slot) {
  return SLOTS[cat]?.find((s) => s.key === slot)?.label || slot;
}

// 金额显示/合计：数据归一在服务端，前端只读聚合
export function rowMoney(cat, data) {
  const meta = catMeta(cat);
  const n = Number(data?.[meta.sumKey]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
