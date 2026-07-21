/*
 * qn:crypto native module composition.
 *
 * BearSSL-backed implementations live in focused compilation units. This file only registers their exports with QuickJS.
 */

#include <stddef.h>

#include "qn-crypto.h"

static const qn_crypto_component_t *const components[] = {
	&qn_crypto_tls_component,
	&qn_crypto_digest_component,
	&qn_crypto_cipher_component,
	&qn_crypto_ecc_component,
};

static int js_crypto_init(JSContext *ctx, JSModuleDef *module)
{
	for (size_t i = 0; i < sizeof(components) / sizeof(components[0]); i++) {
		const qn_crypto_component_t *component = components[i];
		if (component->init_classes && component->init_classes(ctx) < 0)
			return -1;
		if (JS_SetModuleExportList(ctx, module, component->exports,
		                          component->export_count) < 0)
			return -1;
	}
	return 0;
}

JSModuleDef *js_init_module_qn_crypto(JSContext *ctx, const char *module_name)
{
	JSModuleDef *module = JS_NewCModule(ctx, module_name, js_crypto_init);
	if (!module)
		return NULL;

	for (size_t i = 0; i < sizeof(components) / sizeof(components[0]); i++) {
		const qn_crypto_component_t *component = components[i];
		if (JS_AddModuleExportList(ctx, module, component->exports,
		                          component->export_count) < 0)
			return NULL;
	}
	return module;
}
