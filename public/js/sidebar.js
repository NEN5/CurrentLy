// Retractable sidebar: opens from the logo/arrow button in the header.
// Sidebar items with data-target simply click the existing button with that id,
// so the dashboard's own handlers (calculator, pairing, logout) keep working.
(() => {
  const toggle = document.getElementById("sidebarToggle");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const closeBtn = document.getElementById("sidebarClose");
  if (!toggle || !sidebar || !backdrop || !closeBtn) return;

  const isOpen = () => sidebar.classList.contains("open");

  function setOpen(open, { restoreFocus = true } = {}) {
    sidebar.classList.toggle("open", open);
    backdrop.classList.toggle("open", open);
    document.body.classList.toggle("sidebar-open", open);
    sidebar.inert = !open; // keeps the closed sidebar out of the tab order
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");

    if (open) closeBtn.focus();
    else if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  closeBtn.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));

  sidebar.addEventListener("click", (e) => {
    const item = e.target.closest(".sidebar-item");
    if (!item) return;

    const target = item.dataset.target
      ? document.getElementById(item.dataset.target)
      : null;

    // A dialog opened by the target (or by the item's own handler, data-self)
    // takes focus itself, so only restore it here when the item does nothing
    // else (the "Dashboard" item).
    const opensDialog = target || item.hasAttribute("data-self");
    setOpen(false, { restoreFocus: !opensDialog });
    if (target) target.click();
  });

  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;

    if (e.key === "Escape") {
      setOpen(false);
      return;
    }

    // Keep Tab / Shift+Tab inside the open sidebar.
    if (e.key === "Tab") {
      const buttons = sidebar.querySelectorAll("button");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
})();
