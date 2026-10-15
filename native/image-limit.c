/* macOS only: compiled locally, never downloaded or installed system-wide. */
#include <sys/resource.h>
#include <unistd.h>
#include <stdlib.h>
static void limit(int resource, rlim_t value) {
  struct rlimit bound = { value, value };
  if (setrlimit(resource, &bound) != 0) _exit(126);
}
int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') return 126;
  limit(RLIMIT_CORE, 0);
  limit(RLIMIT_FSIZE, 0);
  limit(RLIMIT_CPU, 8);
  limit(RLIMIT_NOFILE, 64);
  /* Darwin does not provide Linux RLIMIT_DATA semantics for native mappings.
     V8 heap, decoded pixel limits and the parent deadline remain mandatory. */
  execv(argv[1], &argv[1]);
  return 126;
}
