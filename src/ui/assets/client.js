/**
 * dsh-file-convert client bundle: injected into the DSH desktop web client
 * (see the `dsh.client` block in package.json). Mounts the drag-and-drop
 * converter as a "conversation.view" slot tab; the view is an iframe over the
 * routes the plugin registers on the host web server at /dsh-file-convert.
 *
 * Same integration contract as dsh-plugin-beyond-simulator:
 *   window.__ModuleLoader__.load({ id, factory(load) -> { inject, apply } })
 */
;(function () {
  'use strict'
  window.__ModuleLoader__.load({
    id: 'dsh-file-convert',
    factory: function (load) {
      var react = load('react')
      var h = react.createElement

      var IFRAME_STYLE = {
        width: '100%',
        height: '100%',
        border: '0',
        borderRadius: '10px',
        background: '#0f1115',
        minHeight: '480px',
      }

      function ConverterView() {
        return h('iframe', {
          src: '/dsh-file-convert/',
          title: 'dsh-file-convert',
          style: IFRAME_STYLE,
        })
      }

      var mod = {}
      mod.inject = ['slots']
      mod.apply = function (ctx) {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-file-convert',
              order: 30,
              label: function () {
                return '文件转换'
              },
            },
            ConverterView,
          )
        })
      }
      return mod
    },
  })
})()
