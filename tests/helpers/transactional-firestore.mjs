export function createTransactionalFirestore() {
  const documents = new Map();
  let nextVersion = 1;
  let mutex = Promise.resolve();
  let failBeforeCommit = false;
  let loseAcknowledgement = false;

  function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  function doc(path) {
    return { path, id: path.slice(path.lastIndexOf("/") + 1) };
  }

  function read(path) {
    const item = documents.get(path);
    return item ? clone(item.data) : undefined;
  }

  async function runTransaction(callback) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reads = new Map();
      const writes = [];
      let writingStarted = false;

      const transaction = {
        async get(reference) {
          if (writingStarted) throw new Error("transaction_read_after_write");
          const item = documents.get(reference.path);
          reads.set(reference.path, item?.version ?? 0);
          return {
            exists: item !== undefined,
            data: () => clone(item?.data),
          };
        },
        create(reference, data) {
          writingStarted = true;
          writes.push({ kind: "create", path: reference.path, data: clone(data) });
        },
        set(reference, data) {
          writingStarted = true;
          writes.push({ kind: "set", path: reference.path, data: clone(data) });
        },
      };

      const result = await callback(transaction);
      let release;
      const previousMutex = mutex;
      mutex = new Promise((resolve) => { release = resolve; });
      await previousMutex;
      let retry = false;
      try {
        for (const [path, version] of reads) {
          if ((documents.get(path)?.version ?? 0) !== version) {
            retry = true;
            break;
          }
        }
        if (!retry) {
          if (failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error("mock_transaction_failed_before_commit");
          }
          for (const write of writes) {
            if (write.kind === "create" && documents.has(write.path)) {
              retry = true;
              break;
            }
          }
          if (!retry) {
            for (const write of writes) {
              documents.set(write.path, {
                data: clone(write.data),
                version: nextVersion++,
              });
            }
          }
        }
      } finally {
        release();
      }

      if (retry) continue;
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("mock_commit_acknowledgement_lost");
      }
      return result;
    }
    throw new Error("mock_transaction_retry_limit");
  }

  return {
    doc,
    runTransaction,
    read,
    paths: () => [...documents.keys()],
    failNextBeforeCommit() { failBeforeCommit = true; },
    loseNextCommitAcknowledgement() { loseAcknowledgement = true; },
  };
}