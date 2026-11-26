import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent, type WheelEvent } from "react";

const atEnd = (viewport: HTMLElement) => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;

/** User movement controls following. Resize and streamed content can move only a following viewport. */
export function useChatScroll(projectId: string) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const follow = useRef(true), lastTop = useRef(0);
  const [readingHistory, setReadingHistory] = useState(false);
  const setFollowing = useCallback((following: boolean) => {
    if (follow.current === following) return;
    follow.current = following;
    setReadingHistory(!following);
  }, []);
  const scrollToEnd = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, []);
  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    scrollToEnd();
  }, [setFollowing, scrollToEnd]);
  useLayoutEffect(() => {
    jumpToLatest();
    const element = viewport.current, list = content.current;
    if (!element || !list) return;
    const observer = new ResizeObserver(() => { if (follow.current) scrollToEnd(); });
    observer.observe(element);
    observer.observe(list);
    return () => observer.disconnect();
  }, [projectId, jumpToLatest, scrollToEnd]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget, delta = element.scrollTop - lastTop.current;
    lastTop.current = element.scrollTop;
    if (delta < -0.5 && !atEnd(element)) setFollowing(false);
    if (delta > 0.5 && atEnd(element)) setFollowing(true);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) return;
    if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) setFollowing(false);
    if (event.deltaY > 0 && atEnd(event.currentTarget)) setFollowing(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey)) {
      if (event.currentTarget.scrollTop > 0) setFollowing(false);
    }
  };
  return { viewport, content, readingHistory, jumpToLatest, hold: () => setFollowing(false), onScroll, onWheel, onKeyDown };
}
