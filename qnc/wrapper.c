/*
 * qnc wrapper — self-contained binary that extracts embedded support files
 * and execs qjs to run qnc.js.
 *
 * At build time, qnc-pack appends an archive of support files (qjs binary,
 * engine.so, qnc.js, headers, C sources) to this binary. At runtime, the
 * wrapper extracts them to a cache directory and execs qjs qnc.js with the
 * original arguments.
 *
 * Uses only POSIX APIs (no libuv dependency).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <limits.h>
#include <utime.h>
#include <dirent.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#include "embed.h"

/* ---- Little-endian readers ---- */

static uint16_t read_u16(const uint8_t *p) {
	return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read_u32(const uint8_t *p) {
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
	       ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t read_u64(const uint8_t *p) {
	return (uint64_t)read_u32(p) | ((uint64_t)read_u32(p + 4) << 32);
}

static int read_exact(FILE *f, void *buf, size_t len, const char *what) {
	if (fread(buf, 1, len, f) != len) {
		fprintf(stderr, "qnc: failed to read %s: %s\n", what,
			ferror(f) ? strerror(errno) : "short read");
		return -1;
	}
	return 0;
}

static int write_all(FILE *f, const void *buf, size_t len, const char *what) {
	if (fwrite(buf, 1, len, f) != len) {
		fprintf(stderr, "qnc: failed to write %s: %s\n", what, strerror(errno));
		return -1;
	}
	return 0;
}

/* ---- Filesystem helpers ---- */

/* Recursively create parent directories for path */
static int ensure_parent_dirs(const char *path) {
	char *tmp = strdup(path);
	if (!tmp) return -1;
	for (char *p = tmp + 1; *p; p++) {
		if (*p == '/') {
			*p = '\0';
			if (mkdir(tmp, 0700) != 0 && errno != EEXIST) {
				fprintf(stderr, "qnc: mkdir %s failed: %s\n", tmp, strerror(errno));
				free(tmp);
				return -1;
			}
			*p = '/';
		}
	}
	free(tmp);
	return 0;
}

/* Recursively remove a directory tree */
static int rmrf(const char *path) {
	struct stat st;
	if (lstat(path, &st) != 0) {
		if (errno == ENOENT) return 0;
		fprintf(stderr, "qnc: lstat %s failed: %s\n", path, strerror(errno));
		return -1;
	}

	if (S_ISDIR(st.st_mode)) {
		DIR *d = opendir(path);
		if (!d) {
			fprintf(stderr, "qnc: opendir %s failed: %s\n", path, strerror(errno));
			return -1;
		}
		struct dirent *ent;
		while ((ent = readdir(d)) != NULL) {
			if (ent->d_name[0] == '.' &&
			    (ent->d_name[1] == '\0' ||
			     (ent->d_name[1] == '.' && ent->d_name[2] == '\0')))
				continue;
			char child[PATH_MAX];
			int child_len = snprintf(child, sizeof(child), "%s/%s", path, ent->d_name);
			if (child_len < 0 || (size_t)child_len >= sizeof(child)) {
				fprintf(stderr, "qnc: path too long while removing %s/%s\n", path, ent->d_name);
				closedir(d);
				return -1;
			}
			if (rmrf(child) != 0) {
				closedir(d);
				return -1;
			}
		}
		if (closedir(d) != 0) {
			fprintf(stderr, "qnc: closedir %s failed: %s\n", path, strerror(errno));
			return -1;
		}
		if (rmdir(path) != 0) {
			fprintf(stderr, "qnc: rmdir %s failed: %s\n", path, strerror(errno));
			return -1;
		}
	} else if (unlink(path) != 0) {
		fprintf(stderr, "qnc: unlink %s failed: %s\n", path, strerror(errno));
		return -1;
	}
	return 0;
}

/* Get the path to this executable */
static int get_exe_path(char *buf, size_t bufsz) {
#ifdef __APPLE__
	uint32_t size = (uint32_t)bufsz;
	char raw[PATH_MAX];
	if (_NSGetExecutablePath(raw, &size) == 0) {
		if (realpath(raw, buf))
			return 0;
	}
#else
	ssize_t n = readlink("/proc/self/exe", buf, bufsz - 1);
	if (n > 0) {
		buf[n] = '\0';
		return 0;
	}
#endif
	return -1;
}

/* ---- Archive extraction ---- */

/*
 * Extract embedded files from the qnc binary to target_dir.
 * Uses a .stamp file to cache — only re-extracts when the binary changes.
 * Returns 0 on success, -1 on failure.
 */
static int extract_archive(const char *exe_path, const char *target_dir) {
	struct stat exe_stat;
	if (stat(exe_path, &exe_stat) != 0) return -1;

	/* Check if cache is valid via .stamp file */
	char stamp_path[PATH_MAX];
	snprintf(stamp_path, sizeof(stamp_path), "%s/.stamp", target_dir);
	FILE *sf = fopen(stamp_path, "r");
	if (sf) {
		char buf[64] = {0};
		if (fgets(buf, sizeof(buf), sf)) {
			long long stamp_mtime = strtoll(buf, NULL, 10);
			if (stamp_mtime == (long long)exe_stat.st_mtime) {
				fclose(sf);
				return 0;  /* Cache is valid */
			}
		}
		fclose(sf);
		/* Cache is stale — wipe and re-extract */
		if (rmrf(target_dir) != 0) return -1;
	}

	/* Open the binary */
	FILE *f = fopen(exe_path, "rb");
	if (!f) return -1;

	fseek(f, 0, SEEK_END);
	long file_size = ftell(f);

	/* Read footer (last 24 bytes) */
	if (file_size < QNC_PACK_FOOTER_SIZE) { fclose(f); return -1; }
	uint8_t footer[QNC_PACK_FOOTER_SIZE];
	fseek(f, file_size - QNC_PACK_FOOTER_SIZE, SEEK_SET);
	if (read_exact(f, footer, QNC_PACK_FOOTER_SIZE, "archive footer") != 0) {
		fclose(f);
		return -1;
	}

	/* Check magic */
	if (memcmp(footer + 16, QNC_PACK_MAGIC, QNC_PACK_MAGIC_SIZE) != 0) {
		fclose(f);
		return -1;
	}

	uint64_t data_start = read_u64(footer);
	uint32_t file_count = read_u32(footer + 8);
	uint32_t dir_size = read_u32(footer + 12);

	if (file_count == 0) { fclose(f); return -1; }

	/* Read directory */
	uint8_t *dir = malloc(dir_size);
	if (!dir) { fclose(f); return -1; }
	fseek(f, file_size - QNC_PACK_FOOTER_SIZE - dir_size, SEEK_SET);
	if (read_exact(f, dir, dir_size, "archive directory") != 0) {
		free(dir); fclose(f); return -1;
	}

	/* Create target directory */
	if (ensure_parent_dirs(target_dir) != 0) { free(dir); fclose(f); return -1; }
	if (mkdir(target_dir, 0700) != 0 && errno != EEXIST) {
		fprintf(stderr, "qnc: mkdir %s failed: %s\n", target_dir, strerror(errno));
		free(dir); fclose(f); return -1;
	}

	/* Extract files */
	const uint8_t *dp = dir;
	uint64_t file_offset = data_start;

	for (uint32_t i = 0; i < file_count; i++) {
		if (dp + 2 > dir + dir_size) {
			fprintf(stderr, "qnc: truncated archive directory before entry %u\n", i);
			free(dir); fclose(f); return -1;
		}
		uint16_t name_len = read_u16(dp); dp += 2;

		if (dp + name_len + 8 + 4 > dir + dir_size) {
			fprintf(stderr, "qnc: truncated archive directory entry %u\n", i);
			free(dir); fclose(f); return -1;
		}
		char name[1024];
		if (name_len >= sizeof(name)) {
			fprintf(stderr, "qnc: archive entry name too long\n");
			free(dir); fclose(f); return -1;
		}
		memcpy(name, dp, name_len);
		name[name_len] = '\0';
		dp += name_len;

		uint64_t mtime_sec = read_u64(dp); dp += 8;
		uint32_t fsize = read_u32(dp); dp += 4;

		/* Build output path */
		char outpath[PATH_MAX];
		int path_len = snprintf(outpath, sizeof(outpath), "%s/%s", target_dir, name);
		if (path_len < 0 || (size_t)path_len >= sizeof(outpath)) {
			fprintf(stderr, "qnc: archive output path too long for %s\n", name);
			free(dir); fclose(f); return -1;
		}
		if (ensure_parent_dirs(outpath) != 0) { free(dir); fclose(f); return -1; }

		/* Read and write file data */
		if (fseek(f, file_offset, SEEK_SET) != 0) {
			fprintf(stderr, "qnc: seek failed for %s: %s\n", name, strerror(errno));
			free(dir); fclose(f); return -1;
		}
		FILE *out = fopen(outpath, "wb");
		if (!out) {
			fprintf(stderr, "qnc: failed to open %s: %s\n", outpath, strerror(errno));
			free(dir); fclose(f); return -1;
		}
		uint8_t buf[65536];
		uint32_t remaining = fsize;
		while (remaining > 0) {
			size_t chunk = remaining < sizeof(buf) ? remaining : sizeof(buf);
			if (read_exact(f, buf, chunk, name) != 0 ||
			    write_all(out, buf, chunk, outpath) != 0) {
				fclose(out); free(dir); fclose(f); return -1;
			}
			remaining -= chunk;
		}
		if (fclose(out) != 0) {
			fprintf(stderr, "qnc: failed to close %s: %s\n", outpath, strerror(errno));
			free(dir); fclose(f); return -1;
		}

		/* Restore mtime */
		if (mtime_sec > 0) {
			struct utimbuf ut;
			ut.actime = ut.modtime = (time_t)mtime_sec;
			if (utime(outpath, &ut) != 0) {
				fprintf(stderr, "qnc: failed to set mtime on %s: %s\n", outpath, strerror(errno));
				free(dir); fclose(f); return -1;
			}
		}

		/* Make qjs executable */
		if (strcmp(name, "qjs") == 0 && chmod(outpath, 0755) != 0) {
			fprintf(stderr, "qnc: chmod failed for %s: %s\n", outpath, strerror(errno));
			free(dir); fclose(f); return -1;
		}

		file_offset += fsize;
	}

	free(dir);
	if (fclose(f) != 0) {
		fprintf(stderr, "qnc: failed to close archive %s: %s\n", exe_path, strerror(errno));
		return -1;
	}

	/* Write stamp file */
	sf = fopen(stamp_path, "w");
	if (!sf) {
		fprintf(stderr, "qnc: failed to write stamp %s: %s\n", stamp_path, strerror(errno));
		return -1;
	}
	int stamp_failed = fprintf(sf, "%lld", (long long)exe_stat.st_mtime) < 0;
	if (fclose(sf) != 0 || stamp_failed) {
		fprintf(stderr, "qnc: failed to finish stamp %s: %s\n", stamp_path, strerror(errno));
		return -1;
	}

	return 0;
}

/* ---- Main ---- */

int main(int argc, char **argv) {
	/* Find our own executable path */
	char exe_path[PATH_MAX];
	if (get_exe_path(exe_path, sizeof(exe_path)) != 0) {
		/* Fallback to argv[0] with realpath */
		if (!argv[0] || !realpath(argv[0], exe_path)) {
			fprintf(stderr, "qnc: cannot determine executable path\n");
			return 1;
		}
	}

	/* Determine cache directory:
	 * - If --cache-dir is given, use <cache-dir>/_qnc_support/
	 * - Otherwise use ~/.cache/qnc/
	 */
	char cache_dir[PATH_MAX];
	const char *user_cache = NULL;
	for (int i = 1; i < argc - 1; i++) {
		if (strcmp(argv[i], "--cache-dir") == 0) {
			user_cache = argv[i + 1];
			break;
		}
	}

	if (user_cache) {
		snprintf(cache_dir, sizeof(cache_dir), "%s/_qnc_support", user_cache);
	} else {
		const char *home = getenv("HOME");
		if (!home) home = "/tmp";
		snprintf(cache_dir, sizeof(cache_dir), "%s/.cache/qnc", home);
	}

	/* Extract embedded files if needed */
	if (extract_archive(exe_path, cache_dir) != 0) {
		fprintf(stderr, "qnc: failed to extract support files to %s\n", cache_dir);
		return 1;
	}

	/* Build exec argv: <cache_dir>/qjs <cache_dir>/qnc.js <original args...> */
	char qjs_path[PATH_MAX], qnc_js_path[PATH_MAX];
	snprintf(qjs_path, sizeof(qjs_path), "%s/qjs", cache_dir);
	snprintf(qnc_js_path, sizeof(qnc_js_path), "%s/qnc.js", cache_dir);

	/* argc + 2 for qjs and qnc.js, + 1 for NULL terminator */
	char **new_argv = malloc((argc + 3) * sizeof(char *));
	new_argv[0] = qjs_path;
	new_argv[1] = qnc_js_path;
	for (int i = 1; i < argc; i++)
		new_argv[i + 1] = argv[i];
	new_argv[argc + 1] = NULL;

	execv(qjs_path, new_argv);

	/* If exec failed */
	fprintf(stderr, "qnc: failed to exec %s: %s\n", qjs_path, strerror(errno));
	free(new_argv);
	return 1;
}
