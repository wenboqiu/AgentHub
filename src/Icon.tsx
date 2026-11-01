type IconName = "sessions" | "tasks" | "goals" | "settings" | "back" | "plus" | "chevron";

/** Original outline symbols; inherit text colour and remain decorative. */
export default function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    sessions: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 5h8M8 13h5" />,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="4" /><path d="m8 9 1.5 1.5L12 8m2 2h2m-8 6h8" /></>,
    goals: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    settings: <><path d="M9 4 10 2h4l1 2 2 1 2 .2 2 3.6-1 1.8v2.8l1 1.8-2 3.6-2 .2-2 1-1 2h-4l-1-2-2-1-2-.2-2-3.6 1-1.8v-2.8L3 8.8l2-3.6L7 5Z" /><circle cx="12" cy="12" r="3" /></>,
    back: <path d="m14 5-7 7 7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
