/*
 * Turns on the boiling display face (boil.css) once its faces are actually in.
 *
 * The ten faces are ~370 KB together. Flipping the animation on before they
 * arrive would strobe each heading between Minion and the EB Garamond fallback
 * as the files land one by one, so nothing is enabled until every face the page
 * will use has loaded — up to then, and forever if this script never runs, the
 * page is plain EB Garamond and looks finished either way.
 *
 * Reduced motion still gets the hand-drawn face, just held on one frame, which
 * is what the app does too (:root[data-boil='off'] in the app's index.css).
 */
(function () {
  var root = document.documentElement
  if (!document.fonts || !document.fonts.load) return

  // Save-Data is a request not to spend ~370 KB on a typographic flourish.
  var conn = navigator.connection
  if (conn && conn.saveData) return

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // Held on frame 0, only that one face is ever drawn — don't fetch the rest.
  var faces = still ? [0] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

  Promise.all(
    faces.map(function (i) {
      return document.fonts.load('1em "HolmesBoil' + i + '"')
    })
  ).then(function () {
    root.setAttribute('data-boil', still ? 'still' : 'on')
  }, function () {
    /* a face failed to load: leave the page in EB Garamond */
  })
})()
