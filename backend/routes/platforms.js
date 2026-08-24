// 平台搜索 URL 模板与元数据（学习资源生成器 gen_media.js 与学习日程推荐共用）
// keyword 需已 encodeURIComponent

export const SEARCH = {
  bilibili: (kw) => `https://search.bilibili.com/all?keyword=${kw}`,
  zhihu: (kw) => `https://www.zhihu.com/search?type=content&q=${kw}`,
  csdn: (kw) => `https://so.csdn.net/so/search?q=${kw}`,
  wechat: (kw) => `https://weixin.sogou.com/weixin?type=2&query=${kw}`, // 搜狗微信（公众号文章）
  douyin: (kw) => `https://www.douyin.com/search/${kw}`,
  cnki: (kw) => `https://kns.cnki.net/kns8s/defaultresult/index?kw=${kw}&korder=SU`,
  github: (kw) => `https://github.com/search?q=${kw}&type=repositories`,
  tencent: (kw) => `https://v.qq.com/x/search/?q=${kw}`,
};

export const PLATFORM_META = {
  bilibili: { name: 'B站', icon: '📺', color: '#00a1d6' },
  zhihu: { name: '知乎', icon: '🧠', color: '#0084ff' },
  csdn: { name: 'CSDN', icon: '💻', color: '#cf0000' },
  wechat: { name: '微信公众号', icon: '📱', color: '#07c160' },
  douyin: { name: '抖音', icon: '🎵', color: '#3b3b3b' },
  cnki: { name: '知网', icon: '📚', color: '#0b4da2' },
  github: { name: 'GitHub', icon: '🐙', color: '#181717' },
  tencent: { name: '腾讯视频', icon: '🎬', color: '#ff7218' },
};

// 知识点/细分关键词主力平台
export const KNOWLEDGE_PLATFORMS = ['bilibili', 'csdn', 'zhihu'];
