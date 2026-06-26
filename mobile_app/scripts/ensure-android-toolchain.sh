#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLCHAIN_ROOT="${PICFLOW_ANDROID_TOOLCHAIN_ROOT:-${HOME}/.cache/picflow-mobile-toolchain}"
JDK_ROOT="${TOOLCHAIN_ROOT}/jdk"
ANDROID_SDK_ROOT="${TOOLCHAIN_ROOT}/android-sdk"
ANDROID_USER_HOME="${TOOLCHAIN_ROOT}/android-user-home"
CMDLINE_TOOLS_ROOT="${ANDROID_SDK_ROOT}/cmdline-tools"
CMDLINE_TOOLS_BIN="${CMDLINE_TOOLS_ROOT}/latest/bin"
JDK_LINK="${JDK_ROOT}/current"
TMP_ROOT="${TOOLCHAIN_ROOT}/tmp"
JDK_ARCHIVE="${TMP_ROOT}/jdk17.tar.gz"
ANDROID_ARCHIVE="${TMP_ROOT}/commandlinetools.zip"
ANDROID_CMDLINE_TOOLS_URL="${ANDROID_CMDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip}"
PLATFORM_TOOLS_URL="${PLATFORM_TOOLS_URL:-https://dl.google.com/android/repository/platform-tools_r37.0.0-linux.zip}"
BUILD_TOOLS_URL="${BUILD_TOOLS_URL:-https://dl.google.com/android/repository/build-tools_r35_linux.zip}"
ANDROID_PLATFORM_URL="${ANDROID_PLATFORM_URL:-https://dl.google.com/android/repository/platform-35_r02.zip}"
NDK_URL="${NDK_URL:-https://dl.google.com/android/repository/android-ndk-r27b-linux.zip}"
CMAKE_URL="${CMAKE_URL:-https://dl.google.com/android/repository/cmake-3.22.1-linux.zip}"

mkdir -p "${TMP_ROOT}" "${JDK_ROOT}" "${ANDROID_SDK_ROOT}" "${ANDROID_USER_HOME}" "${CMDLINE_TOOLS_ROOT}"

if command -v java >/dev/null 2>&1; then
  SYSTEM_JAVA_BIN="$(readlink -f "$(command -v java)")"
  SYSTEM_JAVA_HOME="$(cd "$(dirname "${SYSTEM_JAVA_BIN}")/.." && pwd)"
  ln -sfn "${SYSTEM_JAVA_HOME}" "${JDK_LINK}"
fi

if [[ ! -x "${JDK_LINK}/bin/java" ]]; then
  echo "Installing JDK 17 into ${JDK_ROOT}"
  rm -rf "${JDK_ROOT}/jdk-"* "${JDK_ROOT}/system-openjdk" "${JDK_LINK}"
  rm -f "${JDK_ARCHIVE}"
  wget -O "${JDK_ARCHIVE}" "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  tar -tzf "${JDK_ARCHIVE}" >/dev/null
  tar -xzf "${JDK_ARCHIVE}" -C "${JDK_ROOT}"
  JDK_DIR="$(find "${JDK_ROOT}" -maxdepth 1 -mindepth 1 -type d -name 'jdk-*' | head -n 1)"
  if [[ -z "${JDK_DIR}" ]]; then
    echo "Adoptium JDK extraction failed, trying Ubuntu packages" >&2
    mkdir -p "${JDK_ROOT}/system-openjdk"
    (
      cd "${TMP_ROOT}"
      rm -f openjdk-17-jdk-headless_*_amd64.deb openjdk-17-jre-headless_*_amd64.deb
      apt-get download openjdk-17-jdk-headless openjdk-17-jre-headless
      dpkg-deb -x openjdk-17-jre-headless_*_amd64.deb "${JDK_ROOT}/system-openjdk"
      dpkg-deb -x openjdk-17-jdk-headless_*_amd64.deb "${JDK_ROOT}/system-openjdk"
    )
    JDK_DIR="$(find "${JDK_ROOT}/system-openjdk/usr/lib/jvm" -maxdepth 1 -mindepth 1 -type d -name 'java-17-openjdk-*' | head -n 1)"
  fi
  if [[ -z "${JDK_DIR}" ]]; then
    echo "Failed to locate a working JDK directory" >&2
    exit 1
  fi
  ln -sfn "${JDK_DIR}" "${JDK_LINK}"
fi

if [[ ! -x "${CMDLINE_TOOLS_BIN}/sdkmanager" ]]; then
  echo "Installing Android command-line tools into ${CMDLINE_TOOLS_ROOT}"
  rm -rf "${CMDLINE_TOOLS_ROOT}/latest" "${CMDLINE_TOOLS_ROOT}/cmdline-tools"
  rm -f "${ANDROID_ARCHIVE}"
  wget -O "${ANDROID_ARCHIVE}" "${ANDROID_CMDLINE_TOOLS_URL}"
  unzip -tq "${ANDROID_ARCHIVE}" >/dev/null
  unzip -q -o "${ANDROID_ARCHIVE}" -d "${CMDLINE_TOOLS_ROOT}"
  if [[ -d "${CMDLINE_TOOLS_ROOT}/cmdline-tools" ]]; then
    mv "${CMDLINE_TOOLS_ROOT}/cmdline-tools" "${CMDLINE_TOOLS_ROOT}/latest"
  fi
fi

export JAVA_HOME="${JDK_LINK}"
export ANDROID_SDK_ROOT
export ANDROID_HOME="${ANDROID_SDK_ROOT}"
export ANDROID_USER_HOME
export ANDROID_AVD_HOME="${ANDROID_USER_HOME}/avd"
export PATH="${JAVA_HOME}/bin:${CMDLINE_TOOLS_BIN}:${ANDROID_SDK_ROOT}/platform-tools:${PATH}"

PROXY_URL="${HTTPS_PROXY:-${HTTP_PROXY:-${https_proxy:-${http_proxy:-}}}}"
if [[ -n "${PROXY_URL}" ]]; then
  PROXY_NO_SCHEME="${PROXY_URL#*://}"
  PROXY_NO_AUTH="${PROXY_NO_SCHEME#*@}"
  PROXY_HOST="${PROXY_NO_AUTH%%:*}"
  PROXY_PORT_WITH_PATH="${PROXY_NO_AUTH#*:}"
  PROXY_PORT="${PROXY_PORT_WITH_PATH%%/*}"
  if [[ "${PROXY_HOST}" != "${PROXY_NO_AUTH}" && -n "${PROXY_PORT}" ]]; then
    PROXY_JAVA_OPTS="-Djava.net.useSystemProxies=true -Dhttp.proxyHost=${PROXY_HOST} -Dhttp.proxyPort=${PROXY_PORT} -Dhttps.proxyHost=${PROXY_HOST} -Dhttps.proxyPort=${PROXY_PORT}"
    export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+${JAVA_TOOL_OPTIONS} }${PROXY_JAVA_OPTS}"
  fi
fi

install_archive_package() {
  local label="$1"
  local url="$2"
  local target_dir="$3"
  local archive_path="$4"
  local marker_path="$5"
  local extract_dir="${TMP_ROOT}/extract-${label}"

  if [[ -e "${marker_path}" ]]; then
    return
  fi

  echo "Installing ${label} into ${target_dir}"
  rm -rf "${extract_dir}" "${target_dir}"
  mkdir -p "${extract_dir}" "$(dirname "${target_dir}")"
  wget -c -O "${archive_path}" "${url}"
  unzip -tq "${archive_path}" >/dev/null
  unzip -q -o "${archive_path}" -d "${extract_dir}"

  shopt -s nullglob dotglob
  local extracted_dirs=("${extract_dir}"/*)
  if [[ ${#extracted_dirs[@]} -eq 1 && -d "${extracted_dirs[0]}" ]]; then
    mv "${extracted_dirs[0]}" "${target_dir}"
  else
    mkdir -p "${target_dir}"
    mv "${extract_dir}"/* "${target_dir}/"
  fi
  shopt -u nullglob dotglob
}

install_archive_package \
  "platform-tools" \
  "${PLATFORM_TOOLS_URL}" \
  "${ANDROID_SDK_ROOT}/platform-tools" \
  "${TMP_ROOT}/platform-tools.zip" \
  "${ANDROID_SDK_ROOT}/platform-tools/adb"

install_archive_package \
  "build-tools-35.0.0" \
  "${BUILD_TOOLS_URL}" \
  "${ANDROID_SDK_ROOT}/build-tools/35.0.0" \
  "${TMP_ROOT}/build-tools-35.0.0.zip" \
  "${ANDROID_SDK_ROOT}/build-tools/35.0.0/source.properties"

install_archive_package \
  "platform-android-35" \
  "${ANDROID_PLATFORM_URL}" \
  "${ANDROID_SDK_ROOT}/platforms/android-35" \
  "${TMP_ROOT}/platform-android-35.zip" \
  "${ANDROID_SDK_ROOT}/platforms/android-35/source.properties"

install_archive_package \
  "ndk-27.1.12297006" \
  "${NDK_URL}" \
  "${ANDROID_SDK_ROOT}/ndk/27.1.12297006" \
  "${TMP_ROOT}/ndk-27.1.12297006.zip" \
  "${ANDROID_SDK_ROOT}/ndk/27.1.12297006/source.properties"

install_archive_package \
  "cmake-3.22.1" \
  "${CMAKE_URL}" \
  "${ANDROID_SDK_ROOT}/cmake/3.22.1" \
  "${TMP_ROOT}/cmake-3.22.1.zip" \
  "${ANDROID_SDK_ROOT}/cmake/3.22.1/bin/cmake"

cat > "${PROJECT_ROOT}/android/local.properties" <<EOF
sdk.dir=${ANDROID_SDK_ROOT}
EOF

GRADLE_PROPS="${PROJECT_ROOT}/android/gradle.properties"
JAVA_PROP="org.gradle.java.home=${JAVA_HOME}"
if grep -q '^org\.gradle\.java\.home=' "${GRADLE_PROPS}"; then
  sed -i "s|^org\\.gradle\\.java\\.home=.*|${JAVA_PROP}|" "${GRADLE_PROPS}"
else
  printf '\n%s\n' "${JAVA_PROP}" >> "${GRADLE_PROPS}"
fi

echo "Toolchain ready"
echo "JAVA_HOME=${JAVA_HOME}"
echo "ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}"
