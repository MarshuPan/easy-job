import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

function readSourceTree(relativePath: string): string {
  return readdirSync(path.join(projectRoot, relativePath), { withFileTypes: true })
    .flatMap((entry) => {
      const childPath = path.join(relativePath, entry.name)
      return entry.isDirectory() ? [readSourceTree(childPath)] : [readProjectFile(childPath)]
    })
    .join('\n')
}

describe('precision instrument theme contract', () => {
  it('uses only the internal agent UI system across source and build configuration', () => {
    const source = [
      readProjectFile('package.json'),
      readProjectFile('wxt.config.ts'),
      readSourceTree('src'),
    ]
      .join('\n')
      .toLowerCase()
    const forbiddenMarkers = [
      ['element', 'plus'].join('-'),
      ['theme', 'chalk'].join('-'),
      ['e', 'h', 'p', '-'].join(''),
    ]

    for (const marker of forbiddenMarkers) expect(source).not.toContain(marker)
    expect(source).toContain("from '@/ui/instrument'")
    expect(readProjectFile('src/pages/zhipin/index.scss')).toContain(
      "@use './styles/instrument-controls.scss'",
    )
  })

  it('does not reintroduce the legacy component-library palette into workspace styles', () => {
    const workspaceTheme = [
      'src/main.scss',
      'src/pages/zhipin/index.scss',
      'src/pages/zhipin/styles/instrument-controls.scss',
      'src/pages/zhipin/components/Ui.css',
      'src/pages/zhipin/components/Config.css',
      'src/pages/zhipin/components/DeliveryRecords.css',
      'src/pages/zhipin/components/Logs.css',
      'src/pages/zhipin/components/RuntimeSettingsDrawer.vue',
      'src/entrypoints/options/style.css',
      'src/components/form/FormSwitch.vue',
    ]
      .map(readProjectFile)
      .join('\n')
      .toLowerCase()

    for (const color of [
      '#409eff',
      '#67c23a',
      '#e6a23c',
      '#f56c6c',
      '#dcdfe6',
      '#f5f7fa',
      '#303133',
      '#606266',
      '#909399',
    ]) {
      expect(workspaceTheme).not.toContain(color)
    }
  })

  it('defines one interaction language for controls and overlays', () => {
    const controls = readProjectFile('src/pages/zhipin/styles/instrument-controls.scss')

    expect(controls).toContain(':hover')
    expect(controls).toContain(':focus-visible')
    expect(controls).toContain(':active')
    expect(controls).toContain('.is-disabled')
    expect(controls).toContain('.agent-ui-drawer')
    expect(controls).toContain('.instrument-popconfirm')
    expect(controls).toContain('background: var(--agent-primary-soft)')
  })

  it('uses the shared instrument empty state instead of a legacy library illustration', () => {
    for (const file of [
      'src/pages/zhipin/components/DeliveryRecords.vue',
      'src/pages/zhipin/components/Logs.vue',
    ]) {
      const source = readProjectFile(file)
      expect(source).toContain('InstrumentEmptyState')
      expect(source).not.toContain('AgentEmpty')
    }
  })

  it('keeps populated record and log frames content-sized like the C direction', () => {
    const records = readProjectFile('src/pages/zhipin/components/DeliveryRecords.css')
    const logs = readProjectFile('src/pages/zhipin/components/Logs.css')

    expect(records).not.toContain('grid-template-rows: auto minmax(0, 1fr) auto')
    expect(records).toContain('justify-content: flex-start')
    expect(logs).not.toContain('@media (max-width: 700px)')
    expect(logs).not.toContain('height: 100%')
  })

  it('uses each active view as the single vertical scroll owner', () => {
    const shell = readProjectFile('src/pages/zhipin/components/Ui.css')
    const filters = readProjectFile('src/pages/zhipin/components/Config.css')
    const settings = readProjectFile('src/pages/zhipin/components/RuntimeSettingsDrawer.vue')
    const viewRule = shell.match(/\.agent-delivery-view\s*\{([^}]*)\}/s)?.[1] ?? ''
    const frameRule =
      shell.match(/\.agent-delivery-workspace \.instrument-frame\s*\{([^}]*)\}/s)?.[1] ?? ''
    const filterPanelRule = filters.match(/\.config-panel--filter\s*\{([^}]*)\}/s)?.[1] ?? ''
    const settingsRule = settings.match(/\.runtime-settings\s*\{([^}]*)\}/s)?.[1] ?? ''

    expect(viewRule).toContain('overflow: auto')
    expect(viewRule).toContain('scrollbar-width: none')
    expect(shell).toContain('.agent-delivery-view::-webkit-scrollbar')
    expect(shell).not.toContain('scrollbar-gutter: stable')
    expect(shell).not.toContain('.agent-delivery-view--records,')
    expect(frameRule).not.toContain('overscroll-behavior')
    expect(filterPanelRule).not.toContain('overflow')
    expect(filterPanelRule).not.toContain('height: 100%')
    expect(settingsRule).not.toContain('overflow')
    expect(settingsRule).not.toContain('height: 100%')
  })

  it('renders select menus as fixed overlays that cannot extend a view scroll area', () => {
    const controls = readProjectFile('src/pages/zhipin/styles/instrument-controls.scss')
    const popperRule = controls.match(/&__popper\s*\{([^}]*)\}/s)?.[1] ?? ''

    expect(popperRule).toContain('position: fixed')
    expect(popperRule).not.toContain('position: absolute')
  })

  it('keeps the dashboard command bank as two full-height instrument controls', () => {
    const component = readProjectFile('src/pages/zhipin/components/OperationPanel.vue')
    const styles = readProjectFile('src/pages/zhipin/components/OperationPanel.styles.css.txt')

    expect(component).toContain('operation-panel__command-group')
    expect(component).not.toContain('AgentButtonGroup')
    expect(component).not.toContain('Settings2')
    expect(styles).toContain('grid-template-rows: repeat(2, minmax(0, 1fr))')
    expect(styles).toContain('grid-template-columns: 160px minmax(0, 1fr)')
    expect(styles).toContain('minmax(46px, 1.2fr)')
    expect(styles).toContain('.operation-panel__command-group')
    expect(styles).not.toContain('.agent-ui-button-group')
  })

  it('uses compact C-direction source rows with a complete inline search-rule editor', () => {
    const filters = readProjectFile('src/pages/zhipin/components/Config.vue')
    const filterStyles = readProjectFile('src/pages/zhipin/components/Config.css')
    const settings = readProjectFile('src/pages/zhipin/components/RuntimeSettingsDrawer.vue')
    const shell = readProjectFile('src/pages/zhipin/components/Ui.vue')

    expect(filters).not.toContain('AgentCollapse')
    expect(filters.match(/instrument-setting-section/g)).toHaveLength(4)
    expect(filters).not.toContain('AgentDrawer')
    expect(filters).toContain('job-source-row')
    expect(filters).not.toContain('打开搜索规则')
    expect(filters).toContain('search-condition-control')
    expect(filters).toContain('v-if="conf.formData.jobSources.searchEnabled"')
    expect(filters).toContain('data-test="search-rules-module"')
    expect(filters).not.toContain('filter-rules-footer')
    expect(filters).toContain('data-test="reset-search-rules"')
    expect(filters.match(/@change="persistFilterRules"/g)).toHaveLength(6)
    expect(filters).toContain('刷新求职期望')
    expect(filters).not.toContain('个来源已开启')
    expect(filters).not.toContain('filter-select-control')
    expect(filterStyles).toMatch(
      /\.config-panel \.instrument-setting-row\.job-source-row\s*{[^}]*display:\s*grid;[^}]*justify-content:\s*stretch;[^}]*text-align:\s*left;/s,
    )
    expect(filterStyles).toMatch(
      /\.job-source-row \.instrument-setting-copy\s*{[^}]*justify-items:\s*start;[^}]*text-align:\s*left;/s,
    )
    expect(filters).toContain('输入岗位方向后回车')
    expect(filters).toContain('collapse-tags')
    expect(filters).toContain(':max-collapse-tags="2"')
    expect(filters).not.toContain('<div class="instrument-setting-title">岗位方向</div>')
    expect(filters).not.toContain('<div class="instrument-setting-title">BOSS 搜索条件</div>')
    expect(settings.match(/instrument-setting-section/g)).toHaveLength(4)
    expect(settings).toContain('runtime-settings__compound-field')
    expect(settings).toContain('runtime-settings__keyword-select')
    expect(settings).toContain('runtime-settings__keyword-mode')
    expect(settings).toContain('data-test="job-content-toggle-row"')
    expect(settings).toContain('runtime-settings__keyword-panel')
    expect(settings).toContain('runtime-settings__keyword-rule-row')
    expect(settings).toContain('runtime-settings__ai-threshold-panel')
    expect(settings).toContain('v-if="conf.formData.jobContent.enable"')
    expect(settings).toContain('collapse-tags')
    expect(settings).toContain('包含')
    expect(settings).toContain('排除')
    expect(settings).not.toContain('完整 JD 至少命中一个关键词')
    expect(settings).not.toContain('完整 JD 命中任一关键词时过滤')
    expect(settings).toMatch(
      /\.runtime-settings__keyword-mode :deep\(\.agent-ui-radio-button\.is-active\)\s*{[^}]*border-color:\s*var\(--agent-primary\);[^}]*color:\s*var\(--agent-primary-hover\);[^}]*background:\s*var\(--agent-primary-soft\);/s,
    )
    expect(settings).toMatch(
      /\.runtime-settings__keyword-panel \.runtime-settings__keyword-rule-row,\s*\.runtime-settings__ai-threshold-panel \.runtime-settings__ai-threshold-row,\s*\.runtime-settings__greeting-panel \.runtime-settings__greeting-row\s*{[^}]*min-height:\s*0;[^}]*align-items:\s*center;[^}]*padding:\s*0;/s,
    )
    expect(settings).toMatch(
      /\.runtime-settings__keyword-select,\s*\.runtime-settings__text-field input\s*{[^}]*width:\s*min\(560px, 64%\);/s,
    )
    expect(settings).toContain('watchDebounced')
    // 运行配置走 confPersist，AI 任务走独立的 persistAiTasks（契约 §3 的所有权划分）。
    expect(settings).toContain('conf.confPersist()')
    expect(settings).toContain('conf.persistAiTasks()')
    expect(settings).not.toContain('runtime-settings__footer')
    expect(settings).not.toContain('私有配置已加载')
    expect(settings).toContain('runtime-settings__toolbar instrument-view-toolbar')
    expect(settings).toContain('data-test="reset-runtime-settings"')
    expect(shell).not.toContain('data-test="reset-runtime-settings"')
    expect(shell).toContain("eyebrow: 'PROFILE / AI / CONFIG'")
    expect(shell).not.toContain('agent-delivery-workspace__menu-foot')
    expect(shell).not.toContain('privateConfigLabel')
    expect(settings).not.toContain('AgentInputNumber')
  })

  it('shares one adaptive page-toolbar contract without forcing the dashboard into it', () => {
    const records = readProjectFile('src/pages/zhipin/components/DeliveryRecords.vue')
    const filters = readProjectFile('src/pages/zhipin/components/Config.vue')
    const settings = readProjectFile('src/pages/zhipin/components/RuntimeSettingsDrawer.vue')
    const personal = readProjectFile('src/entrypoints/options/App.vue')
    const logs = readProjectFile('src/pages/zhipin/components/Logs.vue')
    const dashboard = readProjectFile('src/pages/zhipin/components/OperationPanel.vue')

    for (const source of [records, filters, settings, personal, logs]) {
      expect(source).toContain('instrument-view-toolbar')
    }
    expect(dashboard).not.toContain('instrument-view-toolbar')
    expect(personal.match(/instrument-setting-section/g)).toHaveLength(3)
    expect(personal).toContain('profile-frame instrument-frame')
  })
})
