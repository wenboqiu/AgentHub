type IconName = "sessions" | "tasks" | "board" | "goals" | "calendar" | "stats" | "settings" | "back" | "plus" | "chevron" | "copy" | "up" | "down" | "speak" | "stop" | "branch" | "edit" | "check" | "close" | "timer" | "refresh" | "image" | "user" | "bell" | "people" | "folder" | "sliders" | "desktop" | "phone";

/** Original outline symbols; inherit text colour and remain decorative. */
export default function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    copy: <><rect x="8" y="8" width="12" height="13" rx="3"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    up: <path d="M7 10v11H3V10h4Zm0 0 5-7c2 0 2 2 1 6h6a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7"/>,
    down: <path d="M7 14V3H3v11h4Zm0 0 5 7c2 0 2-2 1-6h6a2 2 0 0 0 2-2l-2-8a2 2 0 0 0-2-2H7"/>,
    speak: <><path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="3"/>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-4c8 0 12-1 12-6"/></>,
    sessions: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 5h8M8 13h5" />,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="4" /><path d="m8 9 1.5 1.5L12 8m2 2h2m-8 6h8" /></>,
    board: <><rect x="3" y="4" width="5.5" height="16" rx="1.5" /><rect x="9.5" y="4" width="5" height="11" rx="1.5" /><rect x="15.5" y="4" width="5.5" height="8" rx="1.5" /></>,
    goals: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M8 14h3"/></>,
    stats: <path d="M6 20V11M12 20V4M18 20v-6"/>,
    settings: <><path d="M9 4 10 2h4l1 2 2 1 2 .2 2 3.6-1 1.8v2.8l1 1.8-2 3.6-2 .2-2 1-1 2h-4l-1-2-2-1-2-.2-2-3.6 1-1.8v-2.8L3 8.8l2-3.6L7 5Z" /><circle cx="12" cy="12" r="3" /></>,
    back: <path d="m14 5-7 7 7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    edit: <><path d="M4 20h4L19.5 8.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" /><path d="m14.5 7.5 3 3" /></>,
    check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    timer: <><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></>,
    refresh: <><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5V9H15"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 18 5-5 4 4 3-2.5 4 3.5"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></>,
    bell: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></>,
    people: <><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M17.5 20c0-2.4-.8-4.4-2.1-5.9"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
    sliders: <><path d="M4 7h9M19 7h1M4 17h4M14 17h6"/><circle cx="15.5" cy="7" r="2"/><circle cx="10.5" cy="17" r="2"/></>,
    desktop: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></>,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
