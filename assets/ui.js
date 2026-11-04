/* 清单滚动提示：内容超出时给羊皮纸列表一个可见的滚动提示。 */
(function () {
  function update(list) {
    const over = list.scrollHeight > list.clientHeight + 8;
    list.classList.toggle('is-overflowing', over);
    const hint = list.previousElementSibling;
    if (hint && hint.classList.contains('scroll-hint')) hint.hidden = !over;
  }

  function bind(list) {
    const run = function () { update(list); };
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(run).observe(list, { childList: true, subtree: true });
    }
    window.addEventListener('resize', run);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    requestAnimationFrame(run);
  }

  function init() {
    document.querySelectorAll('.map-list').forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
