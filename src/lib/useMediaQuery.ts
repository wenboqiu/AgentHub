import { useEffect, useState } from "react";

/**
 * 订阅一个媒体查询，返回当前是否命中。
 * 用来在「宽屏常驻侧栏 / 窄屏抽屉」之间切换布局——只靠 CSS 做不到，
 * 因为两种形态的 DOM 结构（是否渲染侧栏、头部按钮显不显示）不一样。
 */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
