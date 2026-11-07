<script>
export default {
  onLaunch() {
    // 登录态在 utils/auth.js 模块加载时已从 storage 恢复
    console.log('[Engineer-Compass] miniprogram launched');
  },
};
</script>

<style lang="scss">
/* 全局公共样式（小程序 wxss 不支持 * 选择器，全部用类名） */
page {
  background: #f8fafc;
  color: #1e293b;
  font-size: 28rpx;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.page-wrap { padding: 24rpx 24rpx calc(160rpx + env(safe-area-inset-bottom)); }

.card {
  background: #ffffff;
  border-radius: 20rpx;
  padding: 28rpx;
  margin-bottom: 20rpx;
  border: 1rpx solid #e2e8f0;
  box-shadow: 0 2rpx 12rpx rgba(15, 23, 42, 0.04);
}

.section-title {
  font-size: 30rpx;
  font-weight: 700;
  color: #1e293b;
  margin: 24rpx 8rpx 16rpx;
  display: flex;
  align-items: center;
}
.section-title::before {
  content: '';
  width: 8rpx;
  height: 30rpx;
  border-radius: 4rpx;
  background: #2563eb;
  margin-right: 12rpx;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 88rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
  font-weight: 600;
  border: none;
}
.btn::after { border: none; }
.btn-primary { background: #2563eb; color: #fff; }
.btn-primary[disabled] { background: #93b4f5; color: #fff; }
.btn-ghost { background: #eff6ff; color: #2563eb; }
.btn-outline { background: #fff; color: #2563eb; border: 1rpx solid #2563eb; }
.btn-danger { background: #fee2e2; color: #ef4444; }
.btn-block { width: 100%; }

.tag {
  display: inline-flex;
  align-items: center;
  padding: 4rpx 14rpx;
  border-radius: 8rpx;
  font-size: 22rpx;
  line-height: 1.5;
  margin-right: 10rpx;
}
.tag-blue { background: #eff6ff; color: #2563eb; }
.tag-gray { background: #f1f5f9; color: #64748b; }
.tag-amber { background: #fef3c7; color: #b45309; }
.tag-purple { background: #ede9fe; color: #6d28d9; }
.tag-green { background: #f0fdf4; color: #166534; }
.tag-red { background: #fee2e2; color: #b91c1c; }

.text-muted { color: #64748b; font-size: 24rpx; }
.text-small { font-size: 24rpx; }
.text-bold { font-weight: 700; }
.ellipsis { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ellipsis-2 {
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.empty {
  padding: 100rpx 40rpx;
  text-align: center;
  color: #94a3b8;
}
.empty .empty-icon { font-size: 80rpx; margin-bottom: 20rpx; }
.empty .empty-text { font-size: 28rpx; margin-bottom: 32rpx; }

.safe-bottom { height: calc(40rpx + env(safe-area-inset-bottom)); }

/* 悬浮操作条 */
.action-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 20rpx;
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  background: rgba(255, 255, 255, 0.96);
  border-top: 1rpx solid #e2e8f0;
  z-index: 50;
}
.action-bar .btn { flex: 1; }
</style>