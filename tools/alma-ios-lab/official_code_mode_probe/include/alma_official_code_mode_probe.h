#pragma once
#ifdef __cplusplus
extern "C" {
#endif
/* Blocking one-shot probe. Call off the UI thread in a disposable probe app.
 * Callback JSON is valid only during the call; copy it synchronously.
 * Resource/document paths are unused: no account, filesystem or network tools.
 * A 60-second last-resort watchdog exits the probe process on a stuck runtime.
 */
void alma_official_code_mode_probe_run(const char *resources, const char *documents,
                                     void (*callback)(const char *json));
#ifdef __cplusplus
}
#endif
