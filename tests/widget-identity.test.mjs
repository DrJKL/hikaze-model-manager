import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

class LegacyWidget {}

function adoptWidget(widget) {
    const descriptors = new Map()
    let prototype = widget
    while (prototype && prototype !== Object.prototype) {
        for (const key of Reflect.ownKeys(prototype)) {
            if (key === 'constructor' || descriptors.has(key)) continue
            descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key))
        }
        prototype = Reflect.getPrototypeOf(prototype)
    }
    Reflect.setPrototypeOf(widget, LegacyWidget.prototype)
    Object.defineProperties(widget, Object.fromEntries(descriptors))
    return widget
}

function adoptedWidgets(widgets) {
    const target = widgets.map(adoptWidget)
    const mutationMethods = new Set([
        'copyWithin',
        'fill',
        'push',
        'reverse',
        'shift',
        'sort',
        'splice',
        'unshift'
    ])
    return new Proxy(target, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (!mutationMethods.has(property)) return value
            return (...args) => {
                const result = Reflect.apply(value, target, args)
                target.forEach(adoptWidget)
                return result
            }
        },
        set(target, property, value, receiver) {
            return Reflect.set(
                target,
                property,
                property === 'length' ? value : adoptWidget(value),
                receiver
            )
        }
    })
}

class TestNode {
    constructor(widgets) {
        this.comfyClass = 'HikazePowerLoraLoader'
        this.widgets = widgets
        this.size = [300, 200]
    }

    get widgets() {
        return this._widgets
    }

    set widgets(value) {
        this._widgets = adoptedWidgets(value)
    }

    addWidget(type, name, value, callback, options) {
        const widget = { type, name, value, callback, options }
        this.widgets.push(widget)
        return widget
    }

    computeSize() {
        return [...this.size]
    }

    configure() {}

    serialize() {
        return { inputs: {} }
    }

    setDirtyCanvas() {}
}

async function loadExtension() {
    const root = await mkdtemp(join(tmpdir(), 'hikaze-widget-test-'))
    const extensionDirectory = join(root, 'custom_nodes/hikaze-model-manager/web')
    const scriptsDirectory = join(root, 'custom_nodes/scripts')
    await mkdir(extensionDirectory, { recursive: true })
    await mkdir(scriptsDirectory, { recursive: true })
    await cp('web/comfyui_extension.js', join(extensionDirectory, 'comfyui_extension.js'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(
        join(scriptsDirectory, 'app.js'),
        'export const app = globalThis.__hikazeTestApp\n'
    )

    let extension
    globalThis.__hikazeTestApp = {
        graph: { setDirtyCanvas() {} },
        registerExtension(value) {
            extension = value
        }
    }
    globalThis.LiteGraph = { NODE_WIDGET_HEIGHT: 20 }
    globalThis.window = globalThis
    await import(pathToFileURL(join(extensionDirectory, 'comfyui_extension.js')))
    return { extension, root }
}

test('keeps LoRA panel behavior after frontend widget adoption', async (t) => {
    const { extension, root } = await loadExtension()
    t.after(() => rm(root, { recursive: true }))
    const node = new TestNode([
        { name: 'lora_0', value: 'models/example.safetensors' },
        { name: 'lora_0_on', value: 1 },
        { name: 'lora_0_strength_model', value: 0.8 },
        { name: 'lora_0_strength_clip', value: 0.7 }
    ])

    await extension.nodeCreated(node)

    await t.test('enforces the panel minimum width', () => {
        assert.equal(node.computeSize()[0], 380)
    })

    await t.test('keeps hidden inputs directly after the panel', () => {
        node.updateLoraPanel()
        const panelIndex = node.widgets.findIndex(
            (widget) => widget.name === 'lora_panel'
        )
        assert.equal(node.widgets[panelIndex + 1].name, 'lora_0')
    })

    await t.test('does not duplicate the panel when enhanced again', async () => {
        await extension.nodeCreated(node)
        assert.equal(
            node.widgets.filter((widget) => widget.name === 'lora_panel').length,
            1
        )
    })
})
