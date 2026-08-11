import {
  Check,
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  LoaderCircle,
  Minus,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import type { Component, InjectionKey, PropType, VNodeChild } from 'vue'
import {
  Teleport,
  computed,
  defineComponent,
  h,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  useAttrs,
  watch,
} from 'vue'

export { AgentMessage } from './message'

type ControlSize = 'large' | 'default' | 'small'
type ControlTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'default'
export type AgentCheckboxValueType = string | number | boolean

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function slotChildren(slot: (() => VNodeChild) | undefined): VNodeChild[] {
  const children = slot?.()
  if (children == null) return []
  return Array.isArray(children) ? children : [children]
}

function cssLength(value: string | number | undefined) {
  if (typeof value === 'number') return `${value}px`
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return `${value.trim()}px`
  }
  return value
}

function controlGap(value: string | number | undefined) {
  if (typeof value === 'number') return `${value}px`
  if (value === 'small') return '6px'
  if (value === 'large') return '14px'
  if (value === 'default' || value == null) return '10px'
  return value
}

export const AgentButton = defineComponent({
  name: 'AgentButton',
  inheritAttrs: false,
  props: {
    type: { type: String as PropType<ControlTone>, default: 'default' },
    nativeType: { type: String as PropType<'button' | 'submit' | 'reset'>, default: 'button' },
    size: { type: String as PropType<ControlSize>, default: 'default' },
    disabled: Boolean,
    loading: Boolean,
    plain: Boolean,
    link: Boolean,
    round: Boolean,
    circle: Boolean,
    icon: [Object, Function] as PropType<Component>,
  },
  setup(props, { slots }) {
    const attrs = useAttrs()
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: props.nativeType,
          disabled: props.disabled || props.loading,
          class: classNames(
            'agent-ui-button',
            `agent-ui-button--${props.type}`,
            `agent-ui-button--${props.size}`,
            props.plain && 'is-plain',
            props.link && 'is-link',
            props.round && 'is-round',
            props.circle && 'is-circle',
            props.disabled && 'is-disabled',
            props.loading && 'is-loading',
            attrs.class as string,
          ),
        },
        [
          props.loading
            ? h(LoaderCircle, {
                class: 'agent-ui-button__spinner',
                size: 13,
                'aria-hidden': 'true',
              })
            : props.icon
              ? h(props.icon, { class: 'agent-ui-button__icon', 'aria-hidden': 'true' })
              : null,
          ...slotChildren(slots.default),
        ],
      )
  },
})

export const AgentInput = defineComponent({
  name: 'AgentInput',
  inheritAttrs: false,
  props: {
    modelValue: [String, Number],
    type: { type: String, default: 'text' },
    rows: { type: Number, default: 2 },
    placeholder: String,
    disabled: Boolean,
    readonly: Boolean,
    clearable: Boolean,
    showPassword: Boolean,
    autocomplete: String,
    inputStyle: [String, Object],
    autosize: {
      type: [Boolean, Object] as PropType<boolean | { minRows?: number; maxRows?: number }>,
      default: false,
    },
  },
  emits: ['update:modelValue', 'input', 'change', 'blur', 'focus'],
  setup(props, { emit, expose, slots }) {
    const attrs = useAttrs()
    const inputRef = ref<HTMLInputElement | HTMLTextAreaElement>()
    const passwordVisible = ref(false)
    const resizeTextarea = () => {
      if (!props.autosize) return
      void nextTick(() => {
        const textarea = inputRef.value
        if (!(textarea instanceof HTMLTextAreaElement)) return
        const options = typeof props.autosize === 'object' ? props.autosize : {}
        const style = getComputedStyle(textarea)
        const lineHeight = Number.parseFloat(style.lineHeight) || 20
        const verticalChrome =
          (Number.parseFloat(style.paddingTop) || 0) +
          (Number.parseFloat(style.paddingBottom) || 0) +
          (Number.parseFloat(style.borderTopWidth) || 0) +
          (Number.parseFloat(style.borderBottomWidth) || 0)
        const minHeight = (options.minRows ?? props.rows) * lineHeight + verticalChrome
        const maxHeight =
          (options.maxRows ?? Number.POSITIVE_INFINITY) * lineHeight + verticalChrome
        textarea.style.height = 'auto'
        const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))
        textarea.style.height = `${nextHeight}px`
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
      })
    }
    const actualType = computed(() => {
      if (props.type !== 'password' || !props.showPassword) return props.type
      return passwordVisible.value ? 'text' : 'password'
    })
    const update = (event: Event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement
      emit('update:modelValue', target.value)
      emit('input', target.value)
      resizeTextarea()
    }
    const change = (event: Event) =>
      emit('change', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
    expose({
      focus: () => inputRef.value?.focus(),
      blur: () => inputRef.value?.blur(),
      get textarea() {
        return inputRef.value instanceof HTMLTextAreaElement ? inputRef.value : undefined
      },
    })
    onMounted(resizeTextarea)
    watch(() => props.modelValue, resizeTextarea)

    return () => {
      const { class: rootClass, style: rootStyle, ...controlAttrs } = attrs
      const controlProps = {
        ...controlAttrs,
        ref: inputRef,
        value: props.modelValue ?? '',
        disabled: props.disabled,
        readonly: props.readonly,
        placeholder: props.placeholder,
        autocomplete: props.autocomplete,
        style: [props.inputStyle, props.autosize ? { resize: 'none' } : undefined],
        class: 'agent-ui-input__inner',
        onInput: update,
        onChange: change,
        onBlur: (event: FocusEvent) => emit('blur', event),
        onFocus: (event: FocusEvent) => emit('focus', event),
      }
      const control =
        props.type === 'textarea'
          ? h('textarea', {
              ...controlProps,
              rows:
                typeof props.autosize === 'object'
                  ? (props.autosize.minRows ?? props.rows)
                  : props.rows,
            })
          : h('input', { ...controlProps, type: actualType.value })
      const actions = []
      if (props.clearable && String(props.modelValue ?? '') !== '') {
        actions.push(
          h(
            'button',
            {
              type: 'button',
              class: 'agent-ui-input__action',
              'aria-label': '清空',
              onClick: () => emit('update:modelValue', ''),
            },
            h(X, { size: 13, 'aria-hidden': 'true' }),
          ),
        )
      }
      if (props.type === 'password' && props.showPassword) {
        actions.push(
          h(
            'button',
            {
              type: 'button',
              class: 'agent-ui-input__action',
              'aria-label': passwordVisible.value ? '隐藏密码' : '显示密码',
              onClick: () => (passwordVisible.value = !passwordVisible.value),
            },
            h(passwordVisible.value ? EyeOff : Eye, { size: 14, 'aria-hidden': 'true' }),
          ),
        )
      }
      return h(
        'span',
        { class: classNames('agent-ui-input', rootClass as string), style: rootStyle },
        [
          slots.prepend ? h('span', { class: 'agent-ui-input__prepend' }, slots.prepend()) : null,
          h('span', { class: 'agent-ui-input__wrapper' }, [
            slots.prefix ? h('span', { class: 'agent-ui-input__prefix' }, slots.prefix()) : null,
            control,
            ...actions,
            slots.suffix ? h('span', { class: 'agent-ui-input__suffix' }, slots.suffix()) : null,
          ]),
          slots.append ? h('span', { class: 'agent-ui-input__append' }, slots.append()) : null,
        ],
      )
    }
  },
})

export const AgentInputNumber = defineComponent({
  name: 'AgentInputNumber',
  inheritAttrs: false,
  props: {
    modelValue: Number,
    min: Number,
    max: Number,
    step: { type: Number, default: 1 },
    precision: Number,
    disabled: Boolean,
    controls: { type: Boolean, default: true },
    placeholder: String,
    size: { type: String as PropType<ControlSize>, default: 'default' },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const attrs = useAttrs()
    const normalize = (value: number) => {
      if (props.min != null) value = Math.max(props.min, value)
      if (props.max != null) value = Math.min(props.max, value)
      return props.precision == null ? value : Number(value.toFixed(props.precision))
    }
    const update = (value: number) => {
      const next = normalize(value)
      emit('update:modelValue', next)
      emit('change', next)
    }
    return () => {
      const { class: rootClass, style: rootStyle, ...inputAttrs } = attrs
      return h(
        'span',
        {
          class: classNames(
            'agent-ui-input-number',
            `agent-ui-input-number--${props.size}`,
            props.controls && 'has-controls',
            rootClass as string,
          ),
          style: rootStyle,
        },
        [
          props.controls
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'agent-ui-input-number__decrease',
                  disabled: props.disabled,
                  'aria-label': '减少',
                  onClick: () => update((props.modelValue ?? 0) - props.step),
                },
                h(Minus, { size: 13, 'aria-hidden': 'true' }),
              )
            : null,
          h('span', { class: 'agent-ui-input__wrapper' }, [
            h('input', {
              ...inputAttrs,
              class: 'agent-ui-input__inner',
              type: 'number',
              value: props.modelValue ?? '',
              min: props.min,
              max: props.max,
              step: props.step,
              disabled: props.disabled,
              placeholder: props.placeholder,
              onInput: (event: Event) => {
                const value = Number((event.target as HTMLInputElement).value)
                if (Number.isFinite(value)) emit('update:modelValue', value)
              },
              onChange: (event: Event) => {
                const value = Number((event.target as HTMLInputElement).value)
                if (Number.isFinite(value)) update(value)
              },
            }),
          ]),
          props.controls
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'agent-ui-input-number__increase',
                  disabled: props.disabled,
                  'aria-label': '增加',
                  onClick: () => update((props.modelValue ?? 0) + props.step),
                },
                h(Plus, { size: 13, 'aria-hidden': 'true' }),
              )
            : null,
        ],
      )
    }
  },
})

export const AgentSwitch = defineComponent({
  name: 'AgentSwitch',
  inheritAttrs: false,
  props: {
    modelValue: [Boolean, String, Number],
    activeValue: { type: [Boolean, String, Number], default: true },
    inactiveValue: { type: [Boolean, String, Number], default: false },
    disabled: Boolean,
    size: { type: String as PropType<ControlSize>, default: 'default' },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const attrs = useAttrs()
    const checked = computed(() => props.modelValue === props.activeValue)
    return () => {
      const { class: rootClass, style: rootStyle, ...inputAttrs } = attrs
      return h(
        'label',
        {
          class: classNames(
            'agent-ui-switch',
            `agent-ui-switch--${props.size}`,
            checked.value && 'is-checked',
            props.disabled && 'is-disabled',
            rootClass as string,
          ),
          style: rootStyle,
        },
        [
          h('input', {
            ...inputAttrs,
            class: 'agent-ui-switch__input',
            type: 'checkbox',
            checked: checked.value,
            disabled: props.disabled,
            onChange: (event: Event) => {
              const value = (event.target as HTMLInputElement).checked
                ? props.activeValue
                : props.inactiveValue
              emit('update:modelValue', value)
              emit('change', value)
            },
          }),
          h('span', { class: 'agent-ui-switch__core', 'aria-hidden': 'true' }, [
            h('span', { class: 'agent-ui-switch__action' }),
          ]),
        ],
      )
    }
  },
})

interface CheckboxGroupContext {
  modelValue: () => unknown[]
  disabled: () => boolean
  toggle: (value: unknown, checked: boolean) => void
}

const checkboxGroupKey: InjectionKey<CheckboxGroupContext> = Symbol('agent-checkbox-group')

export const AgentCheckboxGroup = defineComponent({
  name: 'AgentCheckboxGroup',
  props: {
    modelValue: { type: Array as PropType<unknown[]>, default: () => [] },
    disabled: Boolean,
    min: Number,
    max: Number,
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots }) {
    provide(checkboxGroupKey, {
      modelValue: () => props.modelValue,
      disabled: () => props.disabled,
      toggle(value, checked) {
        const next = [...props.modelValue]
        const index = next.findIndex((item) => Object.is(item, value))
        if (checked && index < 0 && (props.max == null || next.length < props.max)) next.push(value)
        if (!checked && index >= 0 && (props.min == null || next.length > props.min))
          next.splice(index, 1)
        emit('update:modelValue', next)
        emit('change', next)
      },
    })
    return () => h('div', { class: 'agent-ui-checkbox-group' }, slotChildren(slots.default))
  },
})

export const AgentCheckbox = defineComponent({
  name: 'AgentCheckbox',
  inheritAttrs: false,
  props: {
    modelValue: { type: [Boolean, Array, String, Number] as PropType<unknown> },
    value: { type: [String, Number, Boolean, Object] as PropType<unknown> },
    label: { type: [String, Number, Boolean] as PropType<unknown> },
    disabled: Boolean,
    border: Boolean,
    size: { type: String as PropType<ControlSize>, default: 'default' },
    trueLabel: { type: [String, Number] as PropType<unknown>, default: true },
    falseLabel: { type: [String, Number] as PropType<unknown>, default: false },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots }) {
    const attrs = useAttrs()
    const group = inject(checkboxGroupKey, null)
    const ownValue = computed(() => props.value ?? props.label ?? true)
    const checked = computed(() => {
      const source = group?.modelValue() ?? props.modelValue
      if (Array.isArray(source)) return source.some((item) => Object.is(item, ownValue.value))
      return source === props.trueLabel || source === true
    })
    const disabled = computed(() => props.disabled || group?.disabled() === true)
    return () => {
      const { class: rootClass, style: rootStyle, ...inputAttrs } = attrs
      return h(
        'label',
        {
          class: classNames(
            'agent-ui-checkbox',
            props.border && 'is-bordered',
            checked.value && 'is-checked',
            disabled.value && 'is-disabled',
            rootClass as string,
          ),
          style: rootStyle,
        },
        [
          h('span', { class: 'agent-ui-checkbox__input' }, [
            h('input', {
              ...inputAttrs,
              type: 'checkbox',
              checked: checked.value,
              disabled: disabled.value,
              onChange: (event: Event) => {
                const nextChecked = (event.target as HTMLInputElement).checked
                if (group) {
                  group.toggle(ownValue.value, nextChecked)
                } else if (Array.isArray(props.modelValue)) {
                  const next = [...props.modelValue]
                  const index = next.findIndex((item) => Object.is(item, ownValue.value))
                  if (nextChecked && index < 0) next.push(ownValue.value)
                  if (!nextChecked && index >= 0) next.splice(index, 1)
                  emit('update:modelValue', next)
                  emit('change', next)
                } else {
                  const next = nextChecked ? props.trueLabel : props.falseLabel
                  emit('update:modelValue', next)
                  emit('change', next)
                }
              },
            }),
            h('span', { class: 'agent-ui-checkbox__inner', 'aria-hidden': 'true' }, [
              checked.value ? h(Check, { size: 11 }) : null,
            ]),
          ]),
          h('span', { class: 'agent-ui-checkbox__label' }, [
            ...slotChildren(slots.default),
            slots.default == null && props.label != null ? String(props.label) : null,
          ]),
        ],
      )
    }
  },
})

export const AgentSelect = defineComponent({
  name: 'AgentSelect',
  inheritAttrs: false,
  props: {
    modelValue: { type: [String, Number, Boolean, Array, Object] as PropType<unknown> },
    options: { type: Array as PropType<unknown[]>, default: undefined },
    multiple: Boolean,
    filterable: Boolean,
    allowCreate: Boolean,
    collapseTags: Boolean,
    maxCollapseTags: { type: Number, default: 1 },
    clearable: Boolean,
    disabled: Boolean,
    placeholder: String,
    size: { type: String as PropType<ControlSize>, default: 'default' },
    optionProps: {
      type: Object as PropType<{ label?: string; value?: string; disabled?: string }>,
      default: undefined,
    },
  },
  emits: ['update:modelValue', 'change', 'remove-tag', 'clear'],
  setup(props, { emit, slots }) {
    const attrs = useAttrs()
    const rootRef = ref<HTMLElement>()
    const inputRef = ref<HTMLInputElement>()
    const popperRef = ref<HTMLElement>()
    const popperStyle = ref<Record<string, string>>({})
    const draft = ref('')
    const open = ref(false)
    const values = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
    const collapseLimit = computed(() => Math.max(0, Math.floor(props.maxCollapseTags)))
    const tagsCollapsed = computed(() => props.multiple && props.collapseTags && !open.value)
    const visibleValues = computed(() =>
      tagsCollapsed.value ? values.value.slice(0, collapseLimit.value) : values.value,
    )
    const collapsedTagCount = computed(() =>
      tagsCollapsed.value ? Math.max(0, values.value.length - visibleValues.value.length) : 0,
    )
    const normalizedOptions = computed(() => {
      const labelKey = props.optionProps?.label ?? 'label'
      const valueKey = props.optionProps?.value ?? 'value'
      const disabledKey = props.optionProps?.disabled ?? 'disabled'
      return (props.options ?? []).map((option) => {
        if (option == null || typeof option !== 'object') {
          return { label: String(option ?? ''), value: option, disabled: false, raw: option }
        }
        const record = option as Record<string, unknown>
        const label = record[labelKey] ?? record.label ?? record[valueKey] ?? record.value ?? ''
        const value = record[valueKey] ?? record.value ?? record[labelKey] ?? record.label ?? ''
        return {
          label: String(label),
          value,
          disabled: Boolean(record[disabledKey] ?? record.disabled),
          raw: option,
        }
      })
    })
    const filteredOptions = computed(() => {
      const query = draft.value.trim().toLocaleLowerCase('zh-CN')
      if (!props.filterable || query === '') return normalizedOptions.value
      return normalizedOptions.value.filter((option) =>
        option.label.toLocaleLowerCase('zh-CN').includes(query),
      )
    })
    const selectedLabel = computed(() => {
      const option = normalizedOptions.value.find((item) =>
        isSameValue(item.value, props.modelValue),
      )
      return option?.label ?? String(props.modelValue ?? '')
    })
    const selectedOption = computed(() =>
      normalizedOptions.value.find((item) => isSameValue(item.value, props.modelValue)),
    )
    const canCreateDraft = computed(() => {
      const value = draft.value.trim()
      return (
        props.allowCreate &&
        value !== '' &&
        !normalizedOptions.value.some(
          (option) =>
            option.label.toLocaleLowerCase('zh-CN') === value.toLocaleLowerCase('zh-CN') ||
            String(option.value).toLocaleLowerCase('zh-CN') === value.toLocaleLowerCase('zh-CN'),
        ) &&
        !values.value.some((item) => String(item) === value)
      )
    })
    const isSelected = (value: unknown) =>
      props.multiple
        ? values.value.some((item) => isSameValue(item, value))
        : isSameValue(props.modelValue, value)
    const emitValue = (value: unknown) => {
      emit('update:modelValue', value)
      emit('change', value)
    }
    const selectValue = (value: unknown) => {
      if (props.multiple) {
        const next = [...values.value]
        const index = next.findIndex((item) => isSameValue(item, value))
        if (index >= 0) next.splice(index, 1)
        else next.push(value)
        emitValue(next)
        draft.value = ''
        return
      }
      emitValue(value)
      draft.value = ''
      open.value = false
    }
    const commitDraft = () => {
      const value = draft.value.trim()
      if (!value) return
      const option = normalizedOptions.value.find(
        (item) =>
          item.label.toLocaleLowerCase('zh-CN') === value.toLocaleLowerCase('zh-CN') ||
          String(item.value).toLocaleLowerCase('zh-CN') === value.toLocaleLowerCase('zh-CN'),
      )
      if (option != null) selectValue(option.value)
      else if (props.allowCreate) selectValue(value)
    }
    const removeValue = (value: unknown) => {
      const next = values.value.filter((item) => !Object.is(item, value))
      emitValue(next)
      emit('remove-tag', value)
    }
    const selectedValueLabel = (value: unknown) =>
      normalizedOptions.value.find((option) => isSameValue(option.value, value))?.label ??
      String(value)
    const renderSelectedTag = (value: unknown) =>
      h('span', { class: 'agent-ui-tag agent-ui-tag--info' }, [
        h('span', { class: 'agent-ui-tag__content' }, selectedValueLabel(value)),
        h(
          'button',
          {
            type: 'button',
            class: 'agent-ui-tag__close',
            disabled: props.disabled,
            'aria-label': `移除 ${String(value)}`,
            onClick: (event: MouseEvent) => {
              event.stopPropagation()
              removeValue(value)
            },
          },
          h(X, { size: 11, 'aria-hidden': 'true' }),
        ),
      ])
    const clear = () => {
      emitValue(props.multiple ? [] : '')
      emit('clear')
      draft.value = ''
    }
    const updatePopperPosition = () => {
      if (!open.value || !rootRef.value) return
      const anchor = rootRef.value.querySelector<HTMLElement>('.agent-ui-select__wrapper')
      if (!anchor) return
      const anchorBox = anchor.getBoundingClientRect()
      if (anchorBox.width <= 0 || anchorBox.height <= 0) return

      const viewBox = rootRef.value
        .closest<HTMLElement>('.agent-delivery-view')
        ?.getBoundingClientRect()
      const viewportMargin = 8
      const boundaryTop = Math.max(viewportMargin, viewBox?.top ?? viewportMargin)
      const boundaryRight = Math.min(
        window.innerWidth - viewportMargin,
        viewBox?.right ?? window.innerWidth - viewportMargin,
      )
      const boundaryBottom = Math.min(
        window.innerHeight - viewportMargin,
        viewBox?.bottom ?? window.innerHeight - viewportMargin,
      )
      const boundaryLeft = Math.max(viewportMargin, viewBox?.left ?? viewportMargin)
      const gap = 5
      const preferredMaxHeight = 240
      const naturalHeight = Math.min(
        preferredMaxHeight,
        Math.max(32, popperRef.value?.scrollHeight ?? preferredMaxHeight),
      )
      const spaceAbove = Math.max(0, anchorBox.top - boundaryTop - gap)
      const spaceBelow = Math.max(0, boundaryBottom - anchorBox.bottom - gap)
      const placeAbove = spaceBelow < Math.min(128, naturalHeight) && spaceAbove > spaceBelow
      const availableHeight = placeAbove ? spaceAbove : spaceBelow
      const maxHeight = Math.max(32, Math.min(naturalHeight, availableHeight))
      const width = Math.max(
        180,
        Math.min(anchorBox.width, Math.max(180, boundaryRight - boundaryLeft)),
      )
      const left = Math.min(
        Math.max(anchorBox.left, boundaryLeft),
        Math.max(boundaryLeft, boundaryRight - width),
      )
      const top = placeAbove
        ? Math.max(boundaryTop, anchorBox.top - gap - maxHeight)
        : anchorBox.bottom + gap

      popperStyle.value = {
        position: 'fixed',
        top: `${Math.round(top)}px`,
        left: `${Math.round(left)}px`,
        width: `${Math.round(width)}px`,
        maxHeight: `${Math.round(maxHeight)}px`,
      }
    }
    const setOpen = (value: boolean, focusInput = false) => {
      if (props.disabled && value) return
      open.value = value
      if (!value) {
        draft.value = ''
        inputRef.value?.blur()
        return
      }
      void nextTick(() => {
        updatePopperPosition()
        if (focusInput) inputRef.value?.focus({ preventScroll: true })
      })
    }
    const toggleOpen = () => setOpen(!open.value, !open.value)
    const handleDocumentClick = (event: MouseEvent) => {
      if (rootRef.value?.contains(event.target as Node)) return
      setOpen(false)
    }
    const handleViewportChange = () => updatePopperPosition()
    onMounted(() => {
      document.addEventListener('click', handleDocumentClick)
      document.addEventListener('scroll', handleViewportChange, true)
      window.addEventListener('resize', handleViewportChange)
    })
    onBeforeUnmount(() => {
      document.removeEventListener('click', handleDocumentClick)
      document.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    })
    watch([() => filteredOptions.value.length, () => values.value.length, canCreateDraft], () => {
      if (open.value) void nextTick(updatePopperPosition)
    })

    return () => {
      const selectedValues = props.multiple ? values.value : []
      const showClear =
        props.clearable &&
        (props.multiple
          ? selectedValues.length > 0
          : props.modelValue != null && props.modelValue !== '')
      const showInput = props.filterable || props.allowCreate
      const showExpandedTagList = props.multiple && props.collapseTags && open.value
      const showPopper =
        open.value &&
        (showExpandedTagList ||
          props.options !== undefined ||
          filteredOptions.value.length > 0 ||
          canCreateDraft.value)
      return h(
        'div',
        {
          ...attrs,
          ref: rootRef,
          class: classNames(
            'agent-ui-select',
            `agent-ui-select--${props.size}`,
            open.value && 'is-open',
            tagsCollapsed.value && 'is-tags-collapsed',
            props.multiple && props.collapseTags && open.value && 'is-tags-expanded',
            props.multiple && values.value.length > 0 && 'has-selection',
            props.disabled && 'is-disabled',
            attrs.class as string,
          ),
        },
        [
          h(
            'div',
            {
              class: 'agent-ui-select__wrapper',
              role: 'combobox',
              'aria-expanded': open.value,
              'aria-haspopup': 'listbox',
              onClick: (event: MouseEvent) => {
                if (props.disabled) return
                const target = event.target as HTMLElement
                if (props.collapseTags && open.value && target.closest('input, button') == null) {
                  setOpen(false)
                  return
                }
                setOpen(true, true)
              },
            },
            [
              props.multiple && !showExpandedTagList
                ? h('div', { class: 'agent-ui-select__selection' }, [
                    ...visibleValues.value.map(renderSelectedTag),
                    collapsedTagCount.value > 0
                      ? h(
                          'span',
                          {
                            class: 'agent-ui-tag agent-ui-tag--info agent-ui-select__collapse-tag',
                            'aria-label': `还有 ${collapsedTagCount.value} 个已选项`,
                          },
                          `+${collapsedTagCount.value}`,
                        )
                      : null,
                  ])
                : null,
              showInput
                ? h('input', {
                    ref: inputRef,
                    class: 'agent-ui-select__input',
                    value: open.value || props.multiple ? draft.value : selectedLabel.value,
                    disabled: props.disabled,
                    placeholder:
                      props.multiple && selectedValues.length > 0 && !showExpandedTagList
                        ? ''
                        : props.placeholder,
                    onFocus: () => {
                      if (props.disabled) return
                      setOpen(true)
                      if (!props.multiple) draft.value = ''
                    },
                    onInput: (event: Event) => {
                      draft.value = (event.target as HTMLInputElement).value
                      open.value = true
                    },
                    onKeydown: (event: KeyboardEvent) => {
                      if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault()
                        commitDraft()
                      } else if (
                        event.key === 'Backspace' &&
                        props.multiple &&
                        !draft.value &&
                        selectedValues.length > 0
                      ) {
                        removeValue(selectedValues[selectedValues.length - 1])
                      } else if (event.key === 'Escape') {
                        setOpen(false)
                      }
                    },
                  })
                : h(
                    'button',
                    {
                      type: 'button',
                      class: classNames(
                        'agent-ui-select__value',
                        (props.multiple
                          ? selectedValues.length === 0
                          : selectedLabel.value === '') && 'is-placeholder',
                      ),
                      disabled: props.disabled,
                      onClick: (event: MouseEvent) => {
                        event.stopPropagation()
                        toggleOpen()
                      },
                    },
                    props.multiple
                      ? selectedValues.length === 0
                        ? props.placeholder
                        : `${selectedValues.length} 项已选`
                      : selectedOption.value && slots.label
                        ? slots.label({
                            label: selectedOption.value.label,
                            value: selectedOption.value.value,
                            item: selectedOption.value.raw,
                          })
                        : selectedLabel.value || props.placeholder,
                  ),
              showClear
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'agent-ui-select__clear',
                      'aria-label': '清空',
                      onClick: (event: MouseEvent) => {
                        event.stopPropagation()
                        clear()
                      },
                    },
                    h(X, { size: 13, 'aria-hidden': 'true' }),
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'agent-ui-select__toggle',
                  disabled: props.disabled,
                  'aria-label': open.value ? '收起选项' : '展开选项',
                  onClick: (event: MouseEvent) => {
                    event.stopPropagation()
                    toggleOpen()
                  },
                },
                h(ChevronDown, { size: 14, 'aria-hidden': 'true' }),
              ),
            ],
          ),
          showPopper
            ? h(
                'div',
                {
                  ref: popperRef,
                  class: 'agent-ui-select__popper',
                  role: 'listbox',
                  style: popperStyle.value,
                },
                [
                  showExpandedTagList && selectedValues.length > 0
                    ? h(
                        'div',
                        { class: 'agent-ui-select__tag-list', role: 'group' },
                        selectedValues.map(renderSelectedTag),
                      )
                    : null,
                  ...filteredOptions.value.map((option) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        class: classNames(
                          'agent-ui-select__option',
                          isSelected(option.value) && 'is-selected',
                        ),
                        disabled: option.disabled,
                        role: 'option',
                        'aria-selected': isSelected(option.value),
                        onClick: () => selectValue(option.value),
                      },
                      [
                        h(
                          'span',
                          slots.default ? slots.default({ item: option.raw }) : option.label,
                        ),
                        isSelected(option.value)
                          ? h(Check, { size: 14, 'aria-hidden': 'true' })
                          : null,
                      ],
                    ),
                  ),
                  canCreateDraft.value
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'agent-ui-select__option is-create',
                          onClick: commitDraft,
                        },
                        `添加“${draft.value.trim()}”`,
                      )
                    : null,
                  props.options !== undefined &&
                  filteredOptions.value.length === 0 &&
                  !canCreateDraft.value
                    ? h('div', { class: 'agent-ui-select__empty' }, '没有匹配选项')
                    : null,
                ],
              )
            : null,
        ],
      )
    }
  },
})

function isSameValue(left: unknown, right: unknown) {
  return Object.is(left, right) || String(left ?? '') === String(right ?? '')
}

export const AgentTag = defineComponent({
  name: 'AgentTag',
  props: {
    type: { type: String as PropType<ControlTone>, default: 'info' },
    size: { type: String as PropType<ControlSize>, default: 'default' },
    effect: { type: String as PropType<'plain' | 'light' | 'dark'>, default: 'light' },
    closable: Boolean,
    disableTransitions: Boolean,
  },
  emits: ['close', 'click'],
  setup(props, { emit, slots, attrs }) {
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames(
            'agent-ui-tag',
            `agent-ui-tag--${props.type}`,
            `agent-ui-tag--${props.size}`,
            `is-${props.effect}`,
            attrs.class as string,
          ),
          onClick: (event: MouseEvent) => emit('click', event),
        },
        [
          h('span', { class: 'agent-ui-tag__content' }, slotChildren(slots.default)),
          props.closable
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'agent-ui-tag__close',
                  'aria-label': '移除',
                  onClick: (event: MouseEvent) => {
                    event.stopPropagation()
                    emit('close', event)
                  },
                },
                h(X, { size: 11, 'aria-hidden': 'true' }),
              )
            : null,
        ],
      )
  },
})

export const AgentForm = defineComponent({
  name: 'AgentForm',
  props: {
    model: Object,
    inline: Boolean,
    disabled: Boolean,
    labelPosition: String,
    labelWidth: [String, Number],
  },
  setup(props, { slots, attrs }) {
    provide(Symbol.for('agent-form-disabled') as InjectionKey<boolean>, props.disabled)
    return () =>
      h(
        'form',
        {
          ...attrs,
          class: classNames(
            'agent-ui-form',
            props.inline && 'agent-ui-form--inline',
            attrs.class as string,
          ),
          onSubmit: (event: Event) => event.preventDefault(),
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentFormItem = defineComponent({
  name: 'AgentFormItem',
  props: {
    label: String,
    error: String,
    required: Boolean,
  },
  setup(props, { slots, attrs }) {
    return () =>
      h('div', { ...attrs, class: classNames('agent-ui-form-item', attrs.class as string) }, [
        props.label || slots.label
          ? h('label', { class: 'agent-ui-form-item__label' }, [
              props.required ? h('span', { class: 'agent-ui-form-item__required' }, '*') : null,
              ...(slots.label ? slotChildren(slots.label) : [props.label]),
            ])
          : null,
        h('div', { class: 'agent-ui-form-item__content' }, [
          ...slotChildren(slots.default),
          props.error ? h('span', { class: 'agent-ui-form-item__error' }, props.error) : null,
        ]),
      ])
  },
})

export const AgentLink = defineComponent({
  name: 'AgentLink',
  props: {
    href: String,
    target: String,
    type: { type: String as PropType<ControlTone>, default: 'default' },
    disabled: Boolean,
    underline: { type: Boolean, default: true },
  },
  emits: ['click'],
  setup(props, { emit, slots, attrs }) {
    return () =>
      h(
        props.href ? 'a' : 'button',
        {
          ...attrs,
          class: classNames(
            'agent-ui-link',
            `agent-ui-link--${props.type}`,
            !props.underline && 'is-plain',
            props.disabled && 'is-disabled',
            attrs.class as string,
          ),
          href: props.disabled ? undefined : props.href,
          target: props.target,
          type: props.href ? undefined : 'button',
          disabled: props.href ? undefined : props.disabled,
          onClick: (event: MouseEvent) => {
            if (props.disabled) event.preventDefault()
            else emit('click', event)
          },
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentSpace = defineComponent({
  name: 'AgentSpace',
  props: {
    wrap: Boolean,
    fill: Boolean,
    fillRatio: Number,
    direction: { type: String as PropType<'horizontal' | 'vertical'>, default: 'horizontal' },
    size: [String, Number],
  },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'div',
        {
          ...attrs,
          class: classNames(
            'agent-ui-space',
            props.wrap && 'is-wrap',
            props.fill && 'is-fill',
            props.direction === 'vertical' && 'is-vertical',
            attrs.class as string,
          ),
          style: [
            {
              gap: controlGap(props.size),
              '--agent-space-fill-basis':
                props.fillRatio == null ? undefined : `${props.fillRatio}%`,
            },
            attrs.style,
          ],
        },
        slotChildren(slots.default),
      )
  },
})

function useOverlayClose(
  props: { modelValue: boolean; closeOnClickModal?: boolean },
  requestClose: () => void,
) {
  const closeFromOverlay = (event: MouseEvent) => {
    if (props.closeOnClickModal !== false && event.target === event.currentTarget) requestClose()
  }
  return closeFromOverlay
}

const overlayBaseZIndex = 2147483500

function overlayZIndex(value: number | undefined) {
  if (value == null) return undefined
  return value < 1000 ? overlayBaseZIndex + value : value
}

export const AgentDialog = defineComponent({
  name: 'AgentDialog',
  props: {
    modelValue: Boolean,
    title: String,
    width: { type: [String, Number], default: '520px' },
    height: [String, Number],
    closeOnClickModal: { type: Boolean, default: true },
    closeOnPressEscape: { type: Boolean, default: true },
    showClose: { type: Boolean, default: true },
    destroyOnClose: Boolean,
    modal: { type: Boolean, default: true },
    alignCenter: Boolean,
    draggable: Boolean,
    zIndex: Number,
  },
  emits: ['update:modelValue', 'open', 'close', 'closed'],
  setup(props, { emit, slots, attrs }) {
    const dialogRef = ref<HTMLElement>()
    const dragOffset = reactive({ x: 0, y: 0 })
    let stopDragging: (() => void) | undefined
    const requestClose = () => {
      emit('update:modelValue', false)
      emit('close')
      queueMicrotask(() => emit('closed'))
    }
    const closeFromOverlay = useOverlayClose(props, requestClose)
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && props.modelValue && props.closeOnPressEscape) requestClose()
    }
    const startDragging = (event: PointerEvent) => {
      if (!props.draggable || (event.target as HTMLElement).closest('button')) return
      const dialog = dialogRef.value
      if (!dialog) return
      event.preventDefault()
      const bounds = dialog.getBoundingClientRect()
      const startPointer = { x: event.clientX, y: event.clientY }
      const startOffset = { ...dragOffset }
      const move = (moveEvent: PointerEvent) => {
        dragOffset.x = Math.max(
          -bounds.left + 8,
          Math.min(
            window.innerWidth - bounds.right - 8,
            startOffset.x + moveEvent.clientX - startPointer.x,
          ),
        )
        dragOffset.y = Math.max(
          -bounds.top + 8,
          Math.min(
            window.innerHeight - bounds.bottom - 8,
            startOffset.y + moveEvent.clientY - startPointer.y,
          ),
        )
      }
      const stop = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', stop)
        stopDragging = undefined
      }
      stopDragging?.()
      stopDragging = stop
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', stop, { once: true })
    }
    onMounted(() => {
      document.addEventListener('keydown', handleKeydown)
      if (props.modelValue) emit('open')
    })
    onBeforeUnmount(() => {
      document.removeEventListener('keydown', handleKeydown)
      stopDragging?.()
    })
    watch(
      () => props.modelValue,
      (open, previous) => {
        if (open && !previous) {
          dragOffset.x = 0
          dragOffset.y = 0
          emit('open')
        }
      },
    )
    return () => {
      if (!props.modelValue && props.destroyOnClose) return null
      return h(
        Teleport,
        { to: 'body' },
        h(
          'div',
          {
            class: classNames(
              'agent-ui-overlay',
              'is-dialog',
              !props.modal && 'is-modeless',
              props.alignCenter && 'is-align-center',
              !props.modelValue && 'is-hidden',
            ),
            style: { zIndex: overlayZIndex(props.zIndex) },
            onMousedown: closeFromOverlay,
          },
          [
            h(
              'section',
              {
                ...attrs,
                ref: dialogRef,
                class: classNames(
                  'agent-ui-dialog',
                  props.draggable && 'is-draggable',
                  attrs.class as string,
                ),
                role: 'dialog',
                'aria-modal': props.modal ? 'true' : 'false',
                style: [
                  {
                    width: cssLength(props.width),
                    height: cssLength(props.height),
                    transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
                  },
                  attrs.style,
                ],
              },
              [
                h('header', { class: 'agent-ui-dialog__header', onPointerdown: startDragging }, [
                  h(
                    'div',
                    { class: 'agent-ui-dialog__title' },
                    slots.header ? slots.header() : props.title,
                  ),
                  props.showClose
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'agent-ui-dialog__close',
                          'aria-label': '关闭',
                          onClick: requestClose,
                        },
                        h(X, { size: 18, 'aria-hidden': 'true' }),
                      )
                    : null,
                ]),
                h('div', { class: 'agent-ui-dialog__body' }, slotChildren(slots.default)),
                slots.footer
                  ? h('footer', { class: 'agent-ui-dialog__footer' }, slots.footer())
                  : null,
              ],
            ),
          ],
        ),
      )
    }
  },
})

export const AgentDrawer = defineComponent({
  name: 'AgentDrawer',
  props: {
    modelValue: Boolean,
    title: String,
    size: { type: [String, Number], default: '480px' },
    closeOnClickModal: { type: Boolean, default: true },
    closeOnPressEscape: { type: Boolean, default: true },
    showClose: { type: Boolean, default: true },
    destroyOnClose: Boolean,
    zIndex: Number,
  },
  emits: ['update:modelValue', 'close', 'closed'],
  setup(props, { emit, slots, attrs }) {
    const requestClose = () => {
      emit('update:modelValue', false)
      emit('close')
      queueMicrotask(() => emit('closed'))
    }
    const closeFromOverlay = useOverlayClose(props, requestClose)
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && props.modelValue && props.closeOnPressEscape) requestClose()
    }
    onMounted(() => document.addEventListener('keydown', handleKeydown))
    onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
    return () => {
      if (!props.modelValue && props.destroyOnClose) return null
      return h(
        Teleport,
        { to: 'body' },
        h(
          'div',
          {
            class: classNames('agent-ui-overlay', 'is-drawer', !props.modelValue && 'is-hidden'),
            style: { zIndex: overlayZIndex(props.zIndex) },
            onMousedown: closeFromOverlay,
          },
          [
            h(
              'aside',
              {
                ...attrs,
                class: classNames('agent-ui-drawer', attrs.class as string),
                role: 'dialog',
                'aria-modal': 'true',
                style: [{ width: cssLength(props.size) }, attrs.style],
              },
              [
                h('header', { class: 'agent-ui-drawer__header' }, [
                  h(
                    'div',
                    { class: 'agent-ui-drawer__title' },
                    slots.header ? slots.header() : props.title,
                  ),
                  props.showClose
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'agent-ui-drawer__close-btn',
                          'aria-label': '关闭',
                          onClick: requestClose,
                        },
                        h(X, { size: 18, 'aria-hidden': 'true' }),
                      )
                    : null,
                ]),
                h('div', { class: 'agent-ui-drawer__body' }, slotChildren(slots.default)),
                slots.footer
                  ? h('footer', { class: 'agent-ui-drawer__footer' }, slots.footer())
                  : null,
              ],
            ),
          ],
        ),
      )
    }
  },
})

export const AgentPagination = defineComponent({
  name: 'AgentPagination',
  props: {
    currentPage: { type: Number, default: 1 },
    pageSize: { type: Number, default: 10 },
    total: { type: Number, default: 0 },
    pagerCount: { type: Number, default: 7 },
    hideOnSinglePage: Boolean,
    background: Boolean,
    small: Boolean,
  },
  emits: ['update:currentPage', 'current-change', 'change'],
  setup(props, { emit, attrs }) {
    const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
    const pages = computed(() => {
      const count = Math.min(props.pagerCount, pageCount.value)
      const start = Math.max(
        1,
        Math.min(props.currentPage - Math.floor(count / 2), pageCount.value - count + 1),
      )
      return Array.from({ length: count }, (_, index) => start + index)
    })
    const go = (page: number) => {
      const next = Math.max(1, Math.min(page, pageCount.value))
      if (next === props.currentPage) return
      emit('update:currentPage', next)
      emit('current-change', next)
      emit('change', next)
    }
    return () => {
      if (props.hideOnSinglePage && pageCount.value <= 1) return null
      return h(
        'nav',
        {
          ...attrs,
          class: classNames('agent-ui-pagination', attrs.class as string),
          'aria-label': '分页',
        },
        [
          h(
            'button',
            {
              type: 'button',
              disabled: props.currentPage <= 1,
              'aria-label': '上一页',
              onClick: () => go(props.currentPage - 1),
            },
            h(ChevronLeft, { size: 14, 'aria-hidden': 'true' }),
          ),
          ...pages.value.map((page) =>
            h(
              'button',
              {
                type: 'button',
                class: classNames('number', page === props.currentPage && 'is-active'),
                'aria-current': page === props.currentPage ? 'page' : undefined,
                onClick: () => go(page),
              },
              String(page),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: props.currentPage >= pageCount.value,
              'aria-label': '下一页',
              onClick: () => go(props.currentPage + 1),
            },
            h(ChevronRight, { size: 14, 'aria-hidden': 'true' }),
          ),
        ],
      )
    }
  },
})

export const AgentPopconfirm = defineComponent({
  name: 'AgentPopconfirm',
  props: {
    title: String,
    confirmButtonText: { type: String, default: '确认' },
    cancelButtonText: { type: String, default: '取消' },
    popperClass: String,
  },
  emits: ['confirm', 'cancel'],
  setup(props, { emit, slots }) {
    const open = ref(false)
    return () =>
      h('span', { class: 'agent-ui-popconfirm' }, [
        h(
          'span',
          {
            class: 'agent-ui-popconfirm__reference',
            onClick: (event: MouseEvent) => {
              event.stopPropagation()
              open.value = !open.value
            },
          },
          slotChildren(slots.reference),
        ),
        open.value
          ? h(
              'span',
              {
                class: classNames(
                  'agent-ui-popper',
                  'agent-ui-popconfirm__panel',
                  props.popperClass,
                ),
              },
              [
                h('span', { class: 'agent-ui-popconfirm__main' }, props.title),
                h('span', { class: 'agent-ui-popconfirm__action' }, [
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: (event: MouseEvent) => {
                        event.stopPropagation()
                        open.value = false
                        emit('cancel')
                      },
                    },
                    props.cancelButtonText,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'is-primary',
                      onClick: (event: MouseEvent) => {
                        event.stopPropagation()
                        open.value = false
                        emit('confirm')
                      },
                    },
                    props.confirmButtonText,
                  ),
                ]),
              ],
            )
          : null,
      ])
  },
})

export const AgentTooltip = defineComponent({
  name: 'AgentTooltip',
  props: {
    content: String,
    placement: { type: String, default: 'top' },
    disabled: Boolean,
    rawContent: Boolean,
  },
  setup(props, { slots, attrs }) {
    const content = computed(() =>
      props.rawContent ? props.content?.replace(/<[^>]*>/g, '') : props.content,
    )
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames(
            'agent-ui-tooltip',
            `is-${props.placement}`,
            props.disabled && 'is-disabled',
            attrs.class as string,
          ),
        },
        [
          ...slotChildren(slots.default),
          !props.disabled && content.value
            ? h('span', { class: 'agent-ui-tooltip__content', role: 'tooltip' }, content.value)
            : null,
        ],
      )
  },
})

export interface AgentAlertProps {
  title?: string
  description?: string
  type?: 'success' | 'warning' | 'info' | 'error'
  closable?: boolean
  showIcon?: boolean
}

export interface AgentNotificationProps {
  title?: string
  message?: string
  type?: 'success' | 'warning' | 'info' | 'error'
  duration?: number
}

export const agentAlertProps = {
  title: String,
  description: String,
  type: { type: String as PropType<AgentAlertProps['type']>, default: 'info' },
  closable: { type: Boolean, default: true },
  showIcon: Boolean,
}

export const AgentAlert = defineComponent({
  name: 'AgentAlert',
  props: agentAlertProps,
  emits: ['close'],
  setup(props, { emit, slots, attrs }) {
    return () => {
      const icon =
        props.type === 'success'
          ? CircleCheck
          : props.type === 'warning'
            ? TriangleAlert
            : props.type === 'error'
              ? CircleAlert
              : Info
      return h(
        'div',
        {
          ...attrs,
          class: classNames(
            'agent-ui-alert',
            `agent-ui-alert--${props.type}`,
            props.showIcon && 'has-icon',
            attrs.class as string,
          ),
          role: props.type === 'error' ? 'alert' : 'status',
        },
        [
          props.showIcon
            ? h(icon, { class: 'agent-ui-alert__icon', size: 16, 'aria-hidden': 'true' })
            : null,
          h('div', { class: 'agent-ui-alert__content' }, [
            props.title || slots.title
              ? h(
                  'strong',
                  { class: 'agent-ui-alert__title' },
                  slots.title ? slots.title() : props.title,
                )
              : null,
            h(
              'div',
              { class: 'agent-ui-alert__description' },
              slots.default ? slots.default() : props.description,
            ),
          ]),
          props.closable
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'agent-ui-alert__close',
                  'aria-label': '关闭',
                  onClick: () => emit('close'),
                },
                h(X, { size: 14, 'aria-hidden': 'true' }),
              )
            : null,
        ],
      )
    }
  },
})

export const AgentAvatar = defineComponent({
  name: 'AgentAvatar',
  props: { src: String, alt: String, size: { type: [String, Number], default: 40 }, shape: String },
  setup(props, { slots, attrs }) {
    const dimension = computed(() =>
      typeof props.size === 'number' ? `${props.size}px` : props.size,
    )
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames(
            'agent-ui-avatar',
            props.shape === 'square' && 'is-square',
            attrs.class as string,
          ),
          style: [{ width: dimension.value, height: dimension.value }, attrs.style],
        },
        [
          props.src
            ? h('img', { src: props.src, alt: props.alt ?? '' })
            : slotChildren(slots.default),
        ],
      )
  },
})

export const AgentIcon = defineComponent({
  name: 'AgentIcon',
  props: { size: [String, Number], color: String },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames('agent-ui-icon', attrs.class as string),
          style: [
            {
              fontSize: typeof props.size === 'number' ? `${props.size}px` : props.size,
              color: props.color,
            },
            attrs.style,
          ],
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentText = defineComponent({
  name: 'AgentText',
  props: { type: String, size: String, truncated: Boolean, lineClamp: [String, Number] },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames(
            'agent-ui-text',
            props.type && `agent-ui-text--${props.type}`,
            props.truncated && 'is-truncated',
            attrs.class as string,
          ),
          style: [props.lineClamp ? { WebkitLineClamp: props.lineClamp } : undefined, attrs.style],
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentScrollbar = defineComponent({
  name: 'AgentScrollbar',
  props: { height: [String, Number], maxHeight: [String, Number] },
  setup(props, { slots, attrs }) {
    const length = (value: string | number | undefined) =>
      typeof value === 'number' ? `${value}px` : value
    return () =>
      h(
        'div',
        {
          ...attrs,
          class: classNames('agent-ui-scrollbar', attrs.class as string),
          style: [
            { height: length(props.height), maxHeight: length(props.maxHeight) },
            attrs.style,
          ],
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentColorPicker = defineComponent({
  name: 'AgentColorPicker',
  props: { modelValue: String, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, attrs }) {
    return () =>
      h('input', {
        ...attrs,
        class: classNames('agent-ui-color-picker', attrs.class as string),
        type: 'color',
        value: props.modelValue ?? '#3f7ff5',
        disabled: props.disabled,
        onInput: (event: Event) => {
          const value = (event.target as HTMLInputElement).value
          emit('update:modelValue', value)
          emit('change', value)
        },
      })
  },
})

export const AgentSlider = defineComponent({
  name: 'AgentSlider',
  inheritAttrs: false,
  props: {
    modelValue: Number,
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    disabled: Boolean,
    showInput: Boolean,
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, attrs }) {
    const update = (value: number, commit = false) => {
      emit('update:modelValue', value)
      if (commit) emit('change', value)
    }
    return () =>
      h(
        'span',
        {
          ...attrs,
          class: classNames('agent-ui-slider', attrs.class as string),
        },
        [
          h('input', {
            class: 'agent-ui-slider__range',
            type: 'range',
            value: props.modelValue ?? props.min,
            min: props.min,
            max: props.max,
            step: props.step,
            disabled: props.disabled,
            onInput: (event: Event) => update(Number((event.target as HTMLInputElement).value)),
            onChange: (event: Event) =>
              update(Number((event.target as HTMLInputElement).value), true),
          }),
          props.showInput
            ? h(AgentInputNumber, {
                class: 'agent-ui-slider__input',
                modelValue: props.modelValue ?? props.min,
                min: props.min,
                max: props.max,
                step: props.step,
                disabled: props.disabled,
                controls: false,
                'onUpdate:modelValue': (value: number) => update(value),
                onChange: (value: number) => update(value, true),
              })
            : null,
        ],
      )
  },
})

interface RadioGroupContext {
  value: () => unknown
  change: (value: unknown) => void
}

const radioGroupKey: InjectionKey<RadioGroupContext> = Symbol('agent-radio-group')

export const AgentRadioGroup = defineComponent({
  name: 'AgentRadioGroup',
  props: {
    modelValue: { type: [String, Number, Boolean] as PropType<unknown> },
    disabled: Boolean,
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots, attrs }) {
    provide(radioGroupKey, {
      value: () => props.modelValue,
      change: (value) => {
        emit('update:modelValue', value)
        emit('change', value)
      },
    })
    return () =>
      h(
        'div',
        { ...attrs, class: classNames('agent-ui-radio-group', attrs.class as string) },
        slotChildren(slots.default),
      )
  },
})

export const AgentRadioButton = defineComponent({
  name: 'AgentRadioButton',
  props: {
    value: { type: [String, Number, Boolean] as PropType<unknown> },
    label: [String, Number],
    disabled: Boolean,
  },
  setup(props, { slots, attrs }) {
    const group = inject(radioGroupKey, null)
    const value = computed(() => props.value ?? props.label)
    return () => {
      const children = slotChildren(slots.default)
      return h(
        'label',
        {
          ...attrs,
          class: classNames(
            'agent-ui-radio-button',
            group?.value() === value.value && 'is-active',
            attrs.class as string,
          ),
        },
        [
          h('input', {
            type: 'radio',
            value: String(value.value ?? ''),
            checked: group?.value() === value.value,
            disabled: props.disabled,
            onChange: () => group?.change(value.value),
          }),
          h('span', children.length > 0 ? children : String(props.label ?? value.value ?? '')),
        ],
      )
    }
  },
})

export const AgentRow = defineComponent({
  name: 'AgentRow',
  props: { gutter: { type: Number, default: 0 } },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'div',
        {
          ...attrs,
          class: classNames('agent-ui-row', attrs.class as string),
          style: [{ gap: `${props.gutter}px` }, attrs.style],
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentCol = defineComponent({
  name: 'AgentCol',
  props: { span: { type: Number, default: 24 } },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'div',
        {
          ...attrs,
          class: classNames('agent-ui-col', attrs.class as string),
          style: [
            { flex: `${props.span} 1 0`, maxWidth: `${(props.span / 24) * 100}%` },
            attrs.style,
          ],
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentStatistic = defineComponent({
  name: 'AgentStatistic',
  props: {
    value: [String, Number],
    title: String,
    prefix: String,
    suffix: String,
    precision: Number,
  },
  setup(props, { slots, attrs }) {
    const display = computed(() =>
      typeof props.value === 'number' && props.precision != null
        ? props.value.toFixed(props.precision)
        : String(props.value ?? ''),
    )
    return () =>
      h('div', { ...attrs, class: classNames('agent-ui-statistic', attrs.class as string) }, [
        h('div', { class: 'agent-ui-statistic__head' }, slots.title ? slots.title() : props.title),
        h('div', { class: 'agent-ui-statistic__content' }, [
          slots.prefix ? slots.prefix() : props.prefix,
          display.value,
          slots.suffix ? slots.suffix() : props.suffix,
        ]),
      ])
  },
})

const dropdownKey: InjectionKey<(command: unknown) => void> = Symbol('agent-dropdown')

export const AgentDropdown = defineComponent({
  name: 'AgentDropdown',
  props: { trigger: String },
  emits: ['command'],
  setup(_, { emit, slots, attrs }) {
    const detailsRef = ref<HTMLDetailsElement>()
    provide(dropdownKey, (command) => {
      emit('command', command)
      detailsRef.value?.removeAttribute('open')
    })
    return () =>
      h(
        'details',
        {
          ...attrs,
          ref: detailsRef,
          class: classNames('agent-ui-dropdown', attrs.class as string),
        },
        [
          h('summary', { class: 'agent-ui-dropdown__trigger' }, slotChildren(slots.default)),
          h('div', { class: 'agent-ui-dropdown__menu' }, slotChildren(slots.dropdown)),
        ],
      )
  },
})

export const AgentDropdownMenu = defineComponent({
  name: 'AgentDropdownMenu',
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'div',
        { ...attrs, class: classNames('agent-ui-dropdown-menu', attrs.class as string) },
        slotChildren(slots.default),
      )
  },
})

export const AgentDropdownItem = defineComponent({
  name: 'AgentDropdownItem',
  props: {
    command: { type: [String, Number, Object] as PropType<unknown> },
    disabled: Boolean,
    divided: Boolean,
  },
  emits: ['click'],
  setup(props, { emit, slots, attrs }) {
    const dispatch = inject(dropdownKey, null)
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: 'button',
          disabled: props.disabled,
          class: classNames(
            'agent-ui-dropdown-menu__item',
            props.divided && 'is-divided',
            attrs.class as string,
          ),
          onClick: (event: MouseEvent) => {
            const command = props.command ?? event
            emit('click', command)
            dispatch?.(command)
          },
        },
        slotChildren(slots.default),
      )
  },
})

export const AgentPopover = defineComponent({
  name: 'AgentPopover',
  props: {
    content: String,
    title: String,
    trigger: String,
    placement: String,
    width: [String, Number],
    effect: String,
    popperStyle: [String, Object],
  },
  setup(props, { slots, attrs }) {
    return () =>
      h('span', { ...attrs, class: classNames('agent-ui-popover', attrs.class as string) }, [
        h('span', { class: 'agent-ui-popover__reference' }, slotChildren(slots.reference)),
        h(
          'span',
          {
            class: 'agent-ui-popover__content',
            style: [{ width: cssLength(props.width) }, props.popperStyle],
          },
          [
            props.title ? h('strong', props.title) : null,
            ...(slots.default ? slotChildren(slots.default) : [props.content]),
          ],
        ),
      ])
  },
})

interface TableColumnDefinition {
  id: symbol
  type?: 'expand'
  prop?: string
  label?: string
  width?: string | number
  render?: (scope: { row: Record<string, unknown>; $index: number }) => VNodeChild
}

interface TableContext {
  columns: TableColumnDefinition[]
  register: (column: TableColumnDefinition) => void
  unregister: (id: symbol) => void
}

const tableKey: InjectionKey<TableContext> = Symbol('agent-table')

function readPath(source: unknown, path?: string) {
  if (!path) return ''
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value != null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      source,
    )
}

export const AgentTable = defineComponent({
  name: 'AgentTable',
  props: {
    data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
    border: Boolean,
    stripe: Boolean,
    rowKey: { type: String, default: 'id' },
    expandRowKeys: { type: Array as PropType<unknown[]>, default: () => [] },
  },
  emits: ['expand-change'],
  setup(props, { emit, slots, attrs }) {
    const state = reactive<TableContext>({
      columns: [],
      register(column) {
        if (!state.columns.some((item) => item.id === column.id)) state.columns.push(column)
      },
      unregister(id) {
        const index = state.columns.findIndex((item) => item.id === id)
        if (index >= 0) state.columns.splice(index, 1)
      },
    })
    provide(tableKey, state)
    const rowIdentity = (row: Record<string, unknown>, index: number) =>
      readPath(row, props.rowKey) ?? index
    const isExpanded = (row: Record<string, unknown>, index: number) => {
      const identity = rowIdentity(row, index)
      return props.expandRowKeys.some((key) => isSameValue(key, identity))
    }
    return () => {
      const expandColumn = state.columns.find((column) => column.type === 'expand')
      return h(
        'div',
        { ...attrs, class: classNames('agent-ui-table-wrap', attrs.class as string) },
        [
          h('div', { style: 'display:none' }, slotChildren(slots.default)),
          h(
            'table',
            {
              class: classNames(
                'agent-ui-table',
                props.border && 'is-bordered',
                props.stripe && 'is-striped',
              ),
            },
            [
              h('thead', [
                h(
                  'tr',
                  state.columns.map((column) =>
                    h(
                      'th',
                      {
                        style: column.width
                          ? {
                              width:
                                typeof column.width === 'number'
                                  ? `${column.width}px`
                                  : column.width,
                            }
                          : undefined,
                      },
                      column.type === 'expand' ? '' : column.label,
                    ),
                  ),
                ),
              ]),
              h(
                'tbody',
                props.data.flatMap((row, index) => {
                  const expanded = isExpanded(row, index)
                  const identity = rowIdentity(row, index)
                  const rows = [
                    h(
                      'tr',
                      { key: `row-${String(identity)}` },
                      state.columns.map((column) =>
                        h('td', {}, [
                          column.type === 'expand'
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  class: 'agent-ui-table__expand',
                                  'aria-expanded': expanded,
                                  'aria-label': expanded ? '收起详情' : '展开详情',
                                  onClick: () => emit('expand-change', row),
                                },
                                h(expanded ? ChevronDown : ChevronRight, {
                                  size: 14,
                                  'aria-hidden': 'true',
                                }),
                              )
                            : column.render
                              ? column.render({ row, $index: index })
                              : String(readPath(row, column.prop) ?? ''),
                        ]),
                      ),
                    ),
                  ]
                  if (expandColumn?.render && expanded) {
                    rows.push(
                      h('tr', { key: `expanded-${String(identity)}`, class: 'is-expanded-row' }, [
                        h('td', { colspan: state.columns.length }, [
                          expandColumn.render({ row, $index: index }),
                        ]),
                      ]),
                    )
                  }
                  return rows
                }),
              ),
            ],
          ),
        ],
      )
    }
  },
})

export const AgentTableColumn = defineComponent({
  name: 'AgentTableColumn',
  props: {
    type: String as PropType<'expand'>,
    prop: String,
    label: String,
    width: [String, Number],
  },
  setup(props, { slots }) {
    const table = inject(tableKey, null)
    const id = Symbol('agent-table-column')
    onMounted(() =>
      table?.register({
        id,
        type: props.type,
        prop: props.prop,
        label: props.label,
        width: props.width,
        render: slots.default as TableColumnDefinition['render'],
      }),
    )
    onBeforeUnmount(() => table?.unregister(id))
    return () => null
  },
})
