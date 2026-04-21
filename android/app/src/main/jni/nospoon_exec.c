#include <jni.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/wait.h>

// Fork+exec that preserves all open file descriptors.
// Java's ProcessBuilder closes non-standard fds during exec,
// but we need the TUN fd to survive into the child process.
//
// Returns int[2] = { pid, stdout_read_fd }
// Child's stdout is redirected to a pipe so Kotlin can read status.
// Child's stderr goes to logcat (inherited from parent).

JNIEXPORT jintArray JNICALL
Java_com_nospoon_vpn_NativeHelper_exec(JNIEnv *env, jclass cls, jobjectArray args) {
    int argc = (*env)->GetArrayLength(env, args);
    if (argc < 1) return NULL;

    // Convert Java String[] to C char*[]
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    for (int i = 0; i < argc; i++) {
        jstring jstr = (jstring) (*env)->GetObjectArrayElement(env, args, i);
        const char *str = (*env)->GetStringUTFChars(env, jstr, NULL);
        argv[i] = strdup(str);
        (*env)->ReleaseStringUTFChars(env, jstr, str);
    }
    argv[argc] = NULL;

    // Create a pipe for capturing child's stdout
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        for (int i = 0; i < argc; i++) free(argv[i]);
        free(argv);
        return NULL;
    }

    pid_t pid = fork();
    if (pid == 0) {
        // Child process — redirect stdout to pipe, keep stderr for logcat
        close(pipefd[0]); // close read end
        dup2(pipefd[1], STDOUT_FILENO); // stdout → pipe
        close(pipefd[1]); // close original write end (dup'd to stdout)

        // All other fds inherited (including TUN fd)
        execv(argv[0], argv);
        _exit(127);
    }

    // Parent — close write end, return {pid, read_fd}
    close(pipefd[1]);

    for (int i = 0; i < argc; i++) free(argv[i]);
    free(argv);

    jintArray result = (*env)->NewIntArray(env, 2);
    jint vals[2] = { (jint) pid, (jint) pipefd[0] };
    (*env)->SetIntArrayRegion(env, result, 0, 2, vals);
    return result;
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
