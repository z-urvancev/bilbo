const CACHE = 'habit-cal-v2'
const PRECACHE = ['./index.html', './manifest.json', './apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => (k === CACHE ? Promise.resolve() : caches.delete(k))),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone()
        if (res.ok) {
          caches.open(CACHE).then((c) => c.put(request, copy))
        }
        return res
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit
          if (request.mode === 'navigate')
            return caches.match(new URL('./index.html', self.location.href))
          return Promise.reject(new Error('offline'))
        }),
      ),
  )
})
