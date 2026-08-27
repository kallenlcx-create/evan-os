// ====== Evan OS Service Worker ======
// 策略：index.html 网络优先（保证更新）→ 缓存回退；其余静态资源缓存优先
// 版本号递增触发旧缓存清理

const CACHE = 'evan-os-v2'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // 外部请求不拦截

  // 同步服务器 API 不缓存（由云同步引擎管理）
  if (url.pathname.startsWith('/login') || url.pathname.startsWith('/upsert') || url.pathname.startsWith('/changes') || url.pathname.startsWith('/deletions')) return

  // HTML：网络优先，断网回退缓存
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html'))
    )
    return
  }

  // 其他静态资源：缓存优先
  event.respondWith(
    caches.match(req).then(hit => hit ||
      fetch(req).then(res => {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(req, copy))
        return res
      })
    )
  )
})
