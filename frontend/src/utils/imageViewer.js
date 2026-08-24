// 全局图片查看器状态：任意组件 openImage(src, name) 即可唤起全屏预览
import { reactive } from 'vue';

export const viewer = reactive({ visible: false, src: '', name: '图片' });

export function openImage(src, name = '图片') {
  viewer.src = src;
  viewer.name = name;
  viewer.visible = true;
}

export function closeImage() {
  viewer.visible = false;
}
