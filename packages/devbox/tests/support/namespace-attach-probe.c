/* Build a namespace over N files, then attach a fresh state to that image
 * page by page through a serving thread, and count what one lookup fetches.
 * The pages come from a private copy of the built database: the serving
 * side here stands in for the sidecar's page socket. */
#define _GNU_SOURCE
#include "journal-namespace.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void require(int condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}

struct server { int listener; int image; };

static void *serve(void *context) {
  struct server *server = context;
  for (;;) {
    int fd = accept(server->listener, NULL, NULL);
    if (fd < 0) return NULL;
    char line[64];
    size_t used = 0;
    for (;;) {
      ssize_t got = read(fd, line + used, 1);
      if (got <= 0) break;
      if (line[used] == '\n') {
        line[used] = '\0';
        unsigned number = 0;
        unsigned char page[4096];
        if (sscanf(line, "page %u", &number) == 1 && pread(server->image, page, sizeof(page), (off_t)(number - 1) * 4096) == (ssize_t)sizeof(page)) {
          if (write(fd, "ok\n", 3) != 3 || write(fd, page, sizeof(page)) != (ssize_t)sizeof(page)) break;
        } else if (write(fd, "error no such page\n", 19) != 19) break;
        used = 0;
        continue;
      }
      if (++used >= sizeof(line) - 1) break;
    }
    close(fd);
  }
}

static int copy_file(const char *from, const char *to) {
  int in = open(from, O_RDONLY), out = open(to, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (in < 0 || out < 0) return -1;
  char buffer[65536];
  for (;;) {
    ssize_t got = read(in, buffer, sizeof(buffer));
    if (got < 0) return -1;
    if (got == 0) break;
    if (write(out, buffer, (size_t)got) != got) return -1;
  }
  close(in);
  close(out);
  return 0;
}

int main(int argc, char **argv) {
  require(argc == 4, "usage: probe <scratch> <files> <socket>");
  unsigned files = (unsigned)strtoul(argv[2], NULL, 10);
  char root[4096], state[4096], fresh[4096], built[4096], image[4096];
  require(snprintf(root, sizeof(root), "%s/root", argv[1]) < (int)sizeof(root), "root path");
  require(snprintf(state, sizeof(state), "%s/state", argv[1]) < (int)sizeof(state), "state path");
  require(snprintf(fresh, sizeof(fresh), "%s/fresh", argv[1]) < (int)sizeof(fresh), "fresh path");
  require(snprintf(built, sizeof(built), "%s/state/namespace.sqlite", argv[1]) < (int)sizeof(built), "built path");
  require(snprintf(image, sizeof(image), "%s/image.sqlite", argv[1]) < (int)sizeof(image), "image path");
  require(mkdir(root, 0700) == 0 && mkdir(state, 0700) == 0 && mkdir(fresh, 0700) == 0, "scratch directories");
  char nested[4096];
  require(snprintf(nested, sizeof(nested), "%s/ancestor/nested", root) < (int)sizeof(nested), "nested path");
  char ancestor[4096];
  require(snprintf(ancestor, sizeof(ancestor), "%s/ancestor", root) < (int)sizeof(ancestor), "ancestor path");
  require(mkdir(ancestor, 0700) == 0 && mkdir(nested, 0700) == 0, "nested directories");
  int children = open(nested, O_RDONLY | O_DIRECTORY);
  require(children >= 0, "open nested");
  for (unsigned at = 0; at < files; at++) {
    char name[32];
    snprintf(name, sizeof(name), "f%08u", at);
    int fd = openat(children, name, O_CREAT | O_EXCL | O_WRONLY, 0600);
    require(fd >= 0, "create file");
    close(fd);
  }
  close(children);
  int root_fd = open(root, O_RDONLY | O_DIRECTORY);
  require(root_fd >= 0, "open root");

  /* Genesis over the tree, then close: the image is the checkpointed file. */
  struct journal_namespace *space = NULL;
  require(journal_namespace_open(state, root_fd, &space) == 0, "genesis over the tree");
  uint64_t expected = 0;
  require(journal_namespace_id_at(space, "ancestor/nested/f00000042", &expected) == 0, "resolve before attach");
  journal_namespace_close(space);
  require(copy_file(built, image) == 0, "copy the image");
  struct stat st;
  require(stat(image, &st) == 0 && st.st_size % 4096 == 0, "image is whole pages");

  /* Serve the image on a socket, as the sidecar serves the head's pages. */
  struct server server = { .listener = socket(AF_UNIX, SOCK_STREAM, 0), .image = open(image, O_RDONLY) };
  require(server.listener >= 0 && server.image >= 0, "server sockets");
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  require(strlen(argv[3]) < sizeof(address.sun_path), "socket path");
  memcpy(address.sun_path, argv[3], strlen(argv[3]) + 1);
  unlink(argv[3]);
  require(bind(server.listener, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(server.listener, 4) == 0, "listen");
  pthread_t thread;
  require(pthread_create(&thread, NULL, serve, &server) == 0, "serving thread");

  /* A fresh state over the same tree: born, then attached to the image. */
  require(journal_namespace_open(fresh, root_fd, &space) == 0, "fresh genesis");
  struct journal_namespace_work before, attached, looked;
  require(journal_namespace_work(space, &before) == 0, "work before attach");
  require(journal_namespace_attach(space, argv[3], (uint64_t)st.st_size) == 0, "attach lazily");
  require(journal_namespace_work(space, &attached) == 0, "work after attach");
  uint64_t resolved = 0;
  require(journal_namespace_id_at(space, "ancestor/nested/f00000042", &resolved) == 0, "resolve through the image");
  require(resolved == expected, "the attached id is the image's id");
  require(journal_namespace_work(space, &looked) == 0, "work after lookup");
  printf("{\"files\":%u,\"imageBytes\":%lld,\"genesisIngested\":%llu,\"attachFetches\":%llu,\"lookupFetches\":%llu,\"lookupSteps\":%llu,\"lookupFullscanSteps\":%llu}\n",
         files, (long long)st.st_size, (unsigned long long)before.entries_ingested,
         (unsigned long long)attached.page_fetches, (unsigned long long)(looked.page_fetches - attached.page_fetches),
         (unsigned long long)(looked.prepared_steps - attached.prepared_steps),
         (unsigned long long)(looked.prepared_fullscan_steps - attached.prepared_fullscan_steps));
  journal_namespace_close(space);
  close(root_fd);
  return 0;
}
