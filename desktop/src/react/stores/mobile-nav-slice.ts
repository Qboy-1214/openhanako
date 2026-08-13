export type MobileTab = 'chat' | 'channels' | 'market' | 'plugin';

export interface MobileNavSlice {
  /** 移动壳底部 tab bar 当前选中项（与桌面 currentTab 解耦，grill-me 拷问 1·A） */
  mobileActiveTab: MobileTab;
  /** 切换移动壳 tab */
  setMobileActiveTab: (tab: MobileTab) => void;
}

export const createMobileNavSlice = (
  set: (partial: Partial<MobileNavSlice> | ((s: MobileNavSlice) => Partial<MobileNavSlice>)) => void,
): MobileNavSlice => ({
  mobileActiveTab: 'chat',
  setMobileActiveTab: (tab) => set({ mobileActiveTab: tab }),
});
