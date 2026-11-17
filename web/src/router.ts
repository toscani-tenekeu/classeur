import { createRouter, createWebHistory } from 'vue-router'
import { loadSession, signedIn } from '@/composables/useSession'
import { whenSignedOut } from '@/lib/api'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'Sign in', component: () => import('@/pages/Login.vue'), meta: { open: true } },
    { path: '/setup', name: 'Setup', component: () => import('@/pages/Setup.vue'), meta: { open: true } },
    {
      path: '/',
      component: () => import('@/components/AppLayout.vue'),
      children: [
        { path: '', redirect: '/files' },
        { path: 'files', name: 'Files', component: () => import('@/pages/Explorer.vue') },
        { path: 'edit', name: 'Editor', component: () => import('@/pages/Editor.vue') },
        { path: 'trash', name: 'Trash', component: () => import('@/pages/Trash.vue') },
        { path: 'activity', name: 'Activity', component: () => import('@/pages/Activity.vue') },
        { path: 'settings', name: 'Settings', component: () => import('@/pages/Settings.vue') },
      ],
    },
    { path: '/:rest(.*)*', redirect: '/files' },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.open) return true
  if (signedIn.value === null) await loadSession()
  return signedIn.value ? true : { path: '/login' }
})

router.afterEach((to) => {
  const where = typeof to.query.path === 'string' ? to.query.path.split('/').at(-1) || '/' : null
  const label = to.name === 'Files' && where ? where : to.name ? String(to.name) : ''
  document.title = label ? `${label} · Classeur` : 'Classeur'
})

whenSignedOut(() => {
  signedIn.value = false
  if (!router.currentRoute.value.meta.open) void router.push('/login')
})
