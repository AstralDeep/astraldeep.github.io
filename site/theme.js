// Applies the saved appearance before paint; Astral's Midnight theme is the default.
try {
  if (localStorage.getItem('astral-community-theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  document.documentElement.dataset.theme = 'dark';
}
