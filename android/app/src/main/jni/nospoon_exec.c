#include <jni.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/wait.h>

// Fork+exec that preserves all open file descriptors.
// Java's ProcessBuilder closes non-standard fds during exec,
// but we need the TUN fd to survive into the child process.

JNIEXPORT jint JNICALL
Java_com_nospoon_vpn_NativeHelper_exec(JNIEnv *env, jclass cls, jobjectArray args) {
    int argc = (*env)->GetArrayLength(env, args);
    if (argc < 1) return -1;

    // Convert Java String[] to C char*[]
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    for (int i = 0; i < argc; i++) {
        jstring jstr = (jstring) (*env)->GetObjectArrayElement(env, args, i);
        const char *str = (*env)->GetStringUTFChars(env, jstr, NULL);
        argv[i] = strdup(str);
        (*env)->ReleaseStringUTFChars(env, jstr, str);
    }
    argv[argc] = NULL;

    pid_t pid = fork();
    if (pid == 0) {
        // Child process — all fds inherited (including TUN fd)
        execv(argv[0], argv);
        // execv only returns on error
        _exit(127);
    }

    // Parent — free allocated strings
    for (int i = 0; i < argc; i++) free(argv[i]);
    free(argv);

    return (jint) pid;
}

// Send SIGTERM to the child process
JNIEXPORT void JNICALL
Java_com_nospoon_vpn_NativeHelper_kill(JNIEnv *env, jclass cls, jint pid) {
    if (pid > 0) kill((pid_t) pid, SIGTERM);
}

// Wait for child to exit, return exit code (-1 if error)
JNIEXPORT jint JNICALL
Java_com_nospoon_vpn_NativeHelper_waitpid(JNIEnv *env, jclass cls, jint pid) {
    int status = 0;
    pid_t result = waitpid((pid_t) pid, &status, WNOHANG);
    if (result == 0) return -2; // still running
    if (result < 0) return -1;  // error
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -1;
}
