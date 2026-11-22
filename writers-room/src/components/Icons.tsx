// Small hand-tuned line icons (1.75 stroke) so nothing looks like a stock icon set.
type P = { className?: string };
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const Mic = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
  </svg>
);
export const Pen = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M15.5 4.5l4 4L9 19H5v-4L15.5 4.5z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);
export const Tray = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4.5z" />
    <path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5" />
  </svg>
);
export const Check = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const Trash = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M4.5 7h15M10 4h4M6.5 7l.9 11.2A2 2 0 0 0 9.4 20h5.2a2 2 0 0 0 2-1.8L17.5 7" />
  </svg>
);
export const More = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <circle cx="6" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="18" cy="12" r="1" fill="currentColor" />
  </svg>
);
export const Play = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" />
  </svg>
);
export const Pause = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M8 5v14M16 5v14" strokeWidth={3} />
  </svg>
);
export const Download = ({ className = "icon" }: P) => (
  <svg {...base} className={className}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
  </svg>
);
