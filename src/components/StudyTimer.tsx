"use client";

import { useEffect, useRef, useState } from "react";
import { studyHeartbeatAction } from "@/actions/study";
import { fmtDuration } from "@/lib/study-shared";

const TICK = 30;

/** 노트를 읽는 동안(탭이 보이고 최근 60초 안에 활동이 있을 때) 30초마다 학습 시간을 기록한다 */
export function StudyTimer({ subject, slug, initialSeconds }: { subject: string; slug: string; initialSeconds: number }) {
  const [total, setTotal] = useState(initialSeconds);
  const lastActive = useRef(0);
  useEffect(() => {
    lastActive.current = Date.now();
    const touch = () => (lastActive.current = Date.now());
    const events = ["scroll", "mousemove", "keydown", "click", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActive.current > 60_000) return;
      void studyHeartbeatAction(subject, slug, TICK).then((r) => {
        if (r.ok && r.total !== undefined) setTotal(r.total);
      });
    }, TICK * 1000);
    return () => {
      clearInterval(id);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [subject, slug]);
  return <span className="text-xs text-muted" title="탭이 보이고 활동이 있을 때만 30초 단위로 기록">⏱ 이 노트 학습 시간 {fmtDuration(total)}</span>;
}
