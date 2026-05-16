/*
 * qnc-pack — Append support files to a qnc binary
 *
 * Usage: qnc-pack <binary> <name1:file1> [name2:file2] ...
 *
 * Appends files to the binary with an index footer so qnc can
 * extract them at runtime. Each argument is name:path where name
 * is the relative path in the extract directory (e.g. "quickjs.h",
 * "module_resolution/module-resolution.h", "libquickjs.a").
 *
 * File mtimes are preserved in the archive so that extracted files
 * retain their original timestamps for correct incremental builds.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <sys/stat.h>

#include "embed.h"

static int write_all(FILE *f, const void *buf, size_t len, const char *what) {
	if (fwrite(buf, 1, len, f) != len) {
		fprintf(stderr, "qnc-pack: failed to write %s: %s\n", what, strerror(errno));
		return -1;
	}
	return 0;
}

static int write_u16(FILE *f, uint16_t v) {
	uint8_t b[2] = { v & 0xff, (v >> 8) & 0xff };
	return write_all(f, b, sizeof(b), "u16");
}

static int write_u32(FILE *f, uint32_t v) {
	uint8_t b[4] = { v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff };
	return write_all(f, b, sizeof(b), "u32");
}

static int write_u64(FILE *f, uint64_t v) {
	if (write_u32(f, (uint32_t)(v & 0xffffffff)) != 0) return -1;
	return write_u32(f, (uint32_t)(v >> 32));
}

static long file_size(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return -1;
	if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
	long sz = ftell(f);
	fclose(f);
	return sz;
}

static int file_mtime(const char *path, uint64_t *out) {
	struct stat st;
	if (stat(path, &st) != 0) {
		fprintf(stderr, "qnc-pack: stat failed for '%s': %s\n", path, strerror(errno));
		return -1;
	}
	*out = (uint64_t)st.st_mtime;
	return 0;
}

static int copy_file(FILE *dst, const char *src_path) {
	FILE *src = fopen(src_path, "rb");
	if (!src) {
		fprintf(stderr, "qnc-pack: cannot open '%s': %s\n", src_path, strerror(errno));
		return -1;
	}
	uint8_t buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), src)) > 0) {
		if (write_all(dst, buf, n, src_path) != 0) {
			fclose(src);
			return -1;
		}
	}
	if (ferror(src)) {
		fprintf(stderr, "qnc-pack: failed to read '%s': %s\n", src_path, strerror(errno));
		fclose(src);
		return -1;
	}
	fclose(src);
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 3) {
		fprintf(stderr, "usage: qnc-pack <binary> <name:file> ...\n");
		return 1;
	}

	const char *binary = argv[1];
	int nfiles = argc - 2;

	/* Parse name:path pairs */
	const char **names = calloc(nfiles, sizeof(char *));
	const char **paths = calloc(nfiles, sizeof(char *));
	uint32_t *sizes = calloc(nfiles, sizeof(uint32_t));
	uint64_t *mtimes = calloc(nfiles, sizeof(uint64_t));

	for (int i = 0; i < nfiles; i++) {
		char *colon = strchr(argv[i + 2], ':');
		if (!colon) {
			fprintf(stderr, "qnc-pack: bad argument '%s' (expected name:path)\n", argv[i + 2]);
			return 1;
		}
		*colon = '\0';
		names[i] = argv[i + 2];
		paths[i] = colon + 1;
		long sz = file_size(paths[i]);
		if (sz < 0) {
			fprintf(stderr, "qnc-pack: cannot read '%s'\n", paths[i]);
			return 1;
		}
		sizes[i] = (uint32_t)sz;
		if (file_mtime(paths[i], &mtimes[i]) != 0) return 1;
	}

	/* Open binary for appending */
	FILE *f = fopen(binary, "rb");
	if (!f) {
		fprintf(stderr, "qnc-pack: cannot open '%s'\n", binary);
		return 1;
	}
	fseek(f, 0, SEEK_END);
	uint64_t data_start = (uint64_t)ftell(f);
	fclose(f);

	f = fopen(binary, "ab");
	if (!f) {
		fprintf(stderr, "qnc-pack: cannot append to '%s'\n", binary);
		return 1;
	}

	/* Write file data */
	for (int i = 0; i < nfiles; i++) {
		if (copy_file(f, paths[i]) != 0) {
			fprintf(stderr, "qnc-pack: failed to copy '%s'\n", paths[i]);
			fclose(f);
			return 1;
		}
	}

	/* Write directory: name_len(u16) + name + mtime(u64) + size(u32) per entry */
	long dir_start = ftell(f);
	for (int i = 0; i < nfiles; i++) {
		uint16_t name_len = (uint16_t)strlen(names[i]);
		if (write_u16(f, name_len) != 0 ||
		    write_all(f, names[i], name_len, names[i]) != 0 ||
		    write_u64(f, mtimes[i]) != 0 ||
		    write_u32(f, sizes[i]) != 0) {
			fclose(f);
			return 1;
		}
	}
	uint32_t dir_size = (uint32_t)(ftell(f) - dir_start);

	/* Write footer */
	if (write_u64(f, data_start) != 0 ||
	    write_u32(f, (uint32_t)nfiles) != 0 ||
	    write_u32(f, dir_size) != 0 ||
	    write_all(f, QNC_PACK_MAGIC, QNC_PACK_MAGIC_SIZE, "archive magic") != 0) {
		fclose(f);
		return 1;
	}

	if (fclose(f) != 0) {
		fprintf(stderr, "qnc-pack: failed to close '%s': %s\n", binary, strerror(errno));
		return 1;
	}
	free(names);
	free(paths);
	free(sizes);
	free(mtimes);
	return 0;
}
