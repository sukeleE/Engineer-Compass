// 后端地址配置（H5 与小程序共用同一套 Express 接口）
// 1) 线上联调/提审/上线：https://gkjsdh.xyz（已 HTTPS + ICP 备案；微信后台需配置
//    request/uploadFile/downloadFile 合法域名，模拟器与真机调试勾选「不校验合法域名」可绕过，预览/体验版不行）
// 2) 真机局域网联调：http://192.168.1.121:3000（电脑 npm start，手机与电脑同 Wi-Fi，换网络后用 ipconfig 确认 IP）
// 3) 模拟器单机联调：http://localhost:3000
export const BASE_URL = 'https://gkjsdh.xyz';
export const API_BASE = `${BASE_URL}/api`;