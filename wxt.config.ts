import tailwindcss from '@tailwindcss/vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { defineConfig } from 'wxt'

import { version } from './package.json'

const matches = ['*://zhipin.com/*', '*://*.zhipin.com/*']

/** 用户自填的 AI 接口地址无法预先枚举，运行时按需申请。 */
const optionalOrigins = ['http://*/*', 'https://*/*']

const firefoxManifest = {
  browser_specific_settings: {
    gecko: {
      // Firefox 需要显式 ID 才能安装和签名。上架 AMO 前可换成自有域名下的标识。
      id: 'easy-job@extension',
      // MV3 需要 109+。这里取 115 ESR 作为下限，覆盖仍在企业环境里的长期支持版。
      strict_min_version: '115.0',
    },
  },
  /**
   * `optional_host_permissions` 是较新的 Firefox 才认的键，旧版本读的是
   * `optional_permissions` 里的 origin 模式。两个都写，避免落在中间版本的用户
   * 申请不到接口地址权限。Chrome MV3 不接受 optional_permissions 里放 origin，
   * 所以这段只对 Firefox 生效。
   */
  optional_permissions: optionalOrigins,
}

/**
 * 三个目标一律 MV3。
 *
 * WXT 默认给 Firefox 出 MV2，而 MV2 转换会把 `optional_host_permissions` 整个丢掉——
 * 没有等价键，也不报错。用户配置的 AI 接口地址靠 `permissions.request({ origins })`
 * 申请授权（src/config/modelPermission.ts），origin 没预先声明过就必然被拒，
 * 于是 Firefox 上 AI 匹配和 AI 招呼语全部不可用，而构建一路绿灯。
 */
export default defineConfig({
  srcDir: 'src',
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}',
  modules: ['@wxt-dev/module-vue'],
  imports: false,
  manifestVersion: 3,
  zip: {
    zipSources: false,
  },

  manifest: ({ browser }) => ({
    default_locale: 'zh_CN',
    name: 'Easy Job',
    description: 'AI 求职投递助手，支持岗位筛选、AI 匹配度评估、分段打招呼和投递记录管理。',
    permissions: ['storage', 'cookies', 'tabs'],
    web_accessible_resources: [
      {
        resources: ['main-world.js', 'options.html', 'icons/logo.png'],
        matches,
      },
    ],
    host_permissions: ['*://zhipin.com/*', '*://*.zhipin.com/*'],
    optional_host_permissions: optionalOrigins,
    ...(browser === 'firefox' ? firefoxManifest : {}),
  }),
  vite: () => ({
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    ssr: {
      noExternal: ['@webext-core/storage', '@webext-core/messaging', '@webext-core/proxy-service'],
    },
    plugins: [vueJsx(), tailwindcss()],
  }),
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      manifest.content_scripts ??= []
      const zhipinContentScript = manifest.content_scripts.find((item) =>
        item.matches?.some((match) => matches.includes(match)),
      )
      if (zhipinContentScript) {
        zhipinContentScript.css ??= []
        zhipinContentScript.css.push('assets/main-world.css')
      }
    },
  },
})
