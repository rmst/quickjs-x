
let PROJECT_ROOT = `${import.meta.dirname}/..`

let HONO_VERSION = "4.7.4"
let HONO_URL = `https://registry.npmjs.org/hono/-/hono-${HONO_VERSION}.tgz`
let HONO_SHA256 = "d045aad7def83454163e9d58c1613f811c2a81db07d2ebace2bf962ef8130042"

let hono = () => jix.build`
	curl -sL "${HONO_URL}" -o hono.tgz
	HASH=$(sha256sum hono.tgz | cut -d' ' -f1)
	if [ "$HASH" != "${HONO_SHA256}" ]; then
		echo "Hash mismatch: expected ${HONO_SHA256}, got $HASH" >&2
		exit 1
	fi
	tar xzf hono.tgz
	mv package "$out"
`

let image = () => jix.container.imageFromDockerfile`
	FROM docker.io/nixos/nix@\
	sha256:04abdb9c74e0bd20913ca84e4704419af31e49e901cd57253ed8f9762def28fd

	RUN nix-env -iA nixpkgs.gcc
	RUN nix-env -iA nixpkgs.gnumake
	RUN nix-env -iA nixpkgs.gnupatch
	RUN nix-env -iA nixpkgs.nodejs_22
	RUN nix-env -iA nixpkgs.coreutils nixpkgs.findutils nixpkgs.gnugrep nixpkgs.gnused nixpkgs.gnutar nixpkgs.gzip nixpkgs.gawk
	RUN nix-env -iA nixpkgs.curl

	`

let containerRun = () => jix.container.run({image, workdir: "/wd", volumes: {wd: PROJECT_ROOT}})

export const run = {
	containerized: jix.script`
		${containerRun} bash -c '
			make build
			node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
			# qn --test test/*.test.js test/**/*.test.js
		'
	`,

	default: jix.script`
		cd ${import.meta.dirname}/..
		make build
		export PATH="$PWD/bin:$PATH"
		# node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
		qn --test test/*.test.js test/**/*.test.js
	`,

	nonode: jix.script`
		cd ${import.meta.dirname}/..
		# make build
		export PATH="$PWD/bin:$PATH"
		export NO_NODEJS_TESTS=1
		# node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
		qn --test './test/*.test.js' './test/**/*.test.js'
	`,
}
