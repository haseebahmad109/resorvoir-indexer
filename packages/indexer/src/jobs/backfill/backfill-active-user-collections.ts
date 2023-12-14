import { idb } from "@/common/db";

import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import { RabbitMQMessage } from "@/common/rabbit-mq";
import _ from "lodash";
import { fromBuffer, toBuffer } from "@/common/utils";
import { AddressZero } from "@ethersproject/constants";
import { acquireLock } from "@/common/redis";
import { resyncUserCollectionsJob } from "@/jobs/nft-balance-updates/reynsc-user-collections-job";

export type BackfillActiveUserCollectionsJobCursorInfo = {
  lastUpdatedAt: string;
};

export class BackfillActiveUserCollectionsJob extends AbstractRabbitMqJobHandler {
  queueName = "backfill-active-user-collections";
  maxRetries = 10;
  concurrency = 1;
  persistent = false;
  lazyMode = false;
  singleActiveConsumer = true;

  protected async process(payload: BackfillActiveUserCollectionsJobCursorInfo) {
    const { lastUpdatedAt } = payload;
    const values: {
      limit: number;
      AddressZero: Buffer;
      deadAddress: Buffer;
      owner?: Buffer;
      acquiredAt?: string;
    } = {
      limit: 400,
      AddressZero: toBuffer(AddressZero),
      deadAddress: toBuffer("0x000000000000000000000000000000000000dead"),
    };

    let updatedAtFilter = "";
    if (lastUpdatedAt) {
      updatedAtFilter = `AND updated_at >= '${lastUpdatedAt}'`;
    }

    const query = `
      SELECT nte.to as "owner", t.collection_id, updated_at
      FROM nft_transfer_events nte
      JOIN LATERAL (
         SELECT collection_id
         FROM tokens
         WHERE nte.address = tokens.contract
         AND nte.token_id = tokens.token_id
      ) t ON TRUE
      WHERE updated_at > now() - INTERVAL '6 months'
      AND nte.to NOT IN ($/AddressZero/, $/deadAddress/)
      ${updatedAtFilter}
      ORDER BY updated_at
      LIMIT $/limit/
    `;

    const results = await idb.manyOrNone(query, values);

    if (results) {
      for (const result of results) {
        if (_.isNull(result.collection_id)) {
          continue;
        }

        // Check if the user was already synced for this collection
        const lock = `backfill-token-supply:${fromBuffer(result.owner)}:${result.collection_id}`;

        if (await acquireLock(lock, 60 * 60 * 6)) {
          // Trigger resync for the user in the collection
          await resyncUserCollectionsJob.addToQueue([
            {
              user: fromBuffer(result.owner),
              collectionId: result.collection_id,
            },
          ]);
        }
      }
    }

    // Check if there are more potential users to sync
    if (results.length == values.limit) {
      const lastItem = _.last(results);

      return {
        addToQueue: true,
        cursor: { lastUpdatedAt: lastItem.updated_at.toISOString() },
      };
    }

    return { addToQueue: false };
  }

  public async onCompleted(
    rabbitMqMessage: RabbitMQMessage,
    processResult: {
      addToQueue: boolean;
      cursor?: BackfillActiveUserCollectionsJobCursorInfo;
    }
  ) {
    if (processResult.addToQueue) {
      await this.addToQueue(processResult.cursor);
    }
  }

  public async addToQueue(cursor?: BackfillActiveUserCollectionsJobCursorInfo, delay = 0) {
    await this.send({ payload: cursor ?? {} }, delay);
  }
}

export const backfillActiveUserCollectionsJob = new BackfillActiveUserCollectionsJob();

// if (config.chainId !== 1) {
//   redlock
//     .acquire(["backfill-user-collections-lock-4"], 60 * 60 * 24 * 30 * 1000)
//     .then(async () => {
//       await backfillUserCollectionsJob.addToQueue().
//     })
//     .catch(() => {
//       // Skip on any errors
//     });
// }
