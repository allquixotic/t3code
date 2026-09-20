#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <unistd.h>

/* Node exposes no public SO_PEERCRED API. All authorization remains TypeScript;
 * this bridge only returns kernel credentials and disables process inspection. */
static napi_value peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], result; int32_t fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_error(env, NULL, "Invalid socket descriptor"); return NULL;
  }
  struct ucred cred; socklen_t size = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &size) != 0 || size != sizeof(cred)) {
    napi_throw_error(env, NULL, "Peer credential check failed"); return NULL;
  }
  napi_create_uint32(env, cred.uid, &result); return result;
}
static napi_value harden(napi_env env, napi_callback_info info) {
  (void)info;
  struct rlimit limit = {0, 0};
  if (setrlimit(RLIMIT_CORE, &limit) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    napi_throw_error(env, NULL, "Cannot protect service process"); return NULL;
  }
  return NULL;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"peerUid", NULL, peer_uid, NULL, NULL, NULL, napi_default, NULL},
    {"harden", NULL, harden, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 2, descriptors); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
