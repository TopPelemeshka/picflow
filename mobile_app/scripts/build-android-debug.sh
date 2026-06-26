#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

. "${SCRIPT_DIR}/ensure-android-toolchain.sh"

export GRADLE_USER_HOME="${PICFLOW_ANDROID_TOOLCHAIN_ROOT:-${HOME}/.cache/picflow-mobile-toolchain}/gradle-home"
export HOME="${PICFLOW_ANDROID_TOOLCHAIN_ROOT:-${HOME}/.cache/picflow-mobile-toolchain}/home"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+${JAVA_TOOL_OPTIONS} }-Duser.home=${HOME}"

mkdir -p "${GRADLE_USER_HOME}" "${HOME}/.android"

cd "${PROJECT_ROOT}/android"
./gradlew assembleDebug

echo "APK built at ${PROJECT_ROOT}/android/app/build/outputs/apk/debug/app-debug.apk"
