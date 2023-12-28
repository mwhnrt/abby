import { testClient } from "hono/testing";
import { makeProjectDataRoute } from "./v1_project_data";
import { EventService } from "server/services/EventService";
import { jobManager } from "server/queue/Manager";
import { FeatureFlag, FeatureFlagValue, Option, Test } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { trackPlanOverage } from "lib/logsnag";

vi.mock("server/services/EventService", () => ({
  EventService: {
    getEventsForCurrentPeriod: vi.fn(() => {
      return {
        events: 0,
        is80PercentOfLimit: false,
        plan: "PRO",
        planLimits: {
          eventsPerMonth: 100000,
          environments: 100,
          flags: 100,
          tests: 100,
        },
      } satisfies Awaited<
        ReturnType<typeof EventService.getEventsForCurrentPeriod>
      >;
    }),
  },
}));

vi.mock("../../env/server.mjs", () => ({
  env: {},
}));

vi.mock("lib/logsnag", () => ({
  trackPlanOverage: vi.fn(),
}));

vi.mock("server/queue/Manager", () => ({
  jobManager: {
    emit: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("server/db/client", () => ({
  prisma: {
    featureFlagValue: {
      findMany: vi.fn().mockResolvedValue([
        {
          environmentId: "",
          flag: {
            name: "First Flag",
            type: "BOOLEAN",
          },
          flagId: "",
          id: "",
          value: "true",
        },
        {
          environmentId: "",
          flag: {
            name: "First Config",
            type: "NUMBER",
          },
          flagId: "",
          id: "",
          value: "2",
        },
      ] satisfies Array<FeatureFlagValue & { flag: Pick<FeatureFlag, "name" | "type"> }>),
    },
    test: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "",
          name: "First Test",
          createdAt: new Date(),
          projectId: "",
          updatedAt: new Date(),
          options: [
            {
              chance: { toNumber: () => 0.25 } as Decimal,
            },
            {
              chance: { toNumber: () => 0.25 } as Decimal,
            },
            {
              chance: { toNumber: () => 0.25 } as Decimal,
            },
            {
              chance: { toNumber: () => 0.25 } as Decimal,
            },
          ],
        },
      ] satisfies Array<
        Test & {
          options: Array<Pick<Option, "chance">>;
        }
      >),
    },
  },
}));

vi.mock("server/db/redis", () => ({
  redis: {
    get: vi.fn(async () => {}),
    incr: vi.fn(async () => {}),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Get Config", () => {
  it("should return the correct config", async () => {
    const app = makeProjectDataRoute();

    const res = await testClient(app)[":projectId"].$get({
      param: {
        projectId: "test",
      },
      query: {
        environment: "test",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // typeguard to make test fail if data is not AbbyDataResponse
    if ("error" in data) {
      throw new Error("Expected data to not have an error key");
    }
    expect((data as any).error).toBeUndefined();

    expect(data.tests).toHaveLength(1);
    expect(data.tests?.[0]?.name).toBe("First Test");
    expect(data.tests?.[0]?.weights).toEqual([0.25, 0.25, 0.25, 0.25]);

    expect(data.flags).toHaveLength(1);
    expect(data.flags?.[0]?.name).toBe("First Flag");
    expect(data.flags?.[0]?.value).toBe(true);

    expect(data.remoteConfig).toHaveLength(1);
    expect(data.remoteConfig?.[0]?.name).toBe("First Config");
    expect(data.remoteConfig?.[0]?.value).toBe(2);

    expect(vi.mocked(jobManager.emit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jobManager.emit)).toHaveBeenCalledWith(
      "after-data-request",
      expect.objectContaining({})
    );
  });

  it("should not return data if the plan limit is reached", async () => {
    vi.mocked(EventService.getEventsForCurrentPeriod).mockResolvedValueOnce({
      events: 5,
      is80PercentOfLimit: false,
      plan: "PRO",
      planLimits: {
        eventsPerMonth: 1,
        environments: 100,
        flags: 100,
        tests: 100,
      },
    } satisfies Awaited<ReturnType<typeof EventService.getEventsForCurrentPeriod>>);

    const app = makeProjectDataRoute();

    const res = await testClient(app)[":projectId"].$get({
      param: {
        projectId: "test",
      },
      query: {
        environment: "test",
      },
    });
    expect(res.status).toBe(429);
    expect(trackPlanOverage).toHaveBeenCalledTimes(1);
  });
});

describe("Get Config Script", () => {
  it("should return the correct config script", async () => {
    const app = makeProjectDataRoute();

    const res = await testClient(app)[":projectId"]["script.js"].$get({
      param: {
        projectId: "test",
      },
      query: {
        environment: "test",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.text();

    expect(data).toMatchInlineSnapshot('"window.__abby_data__ = {\\"tests\\":[{\\"name\\":\\"First Test\\",\\"weights\\":[0.25,0.25,0.25,0.25]}],\\"flags\\":[{\\"name\\":\\"First Flag\\",\\"value\\":true}],\\"remoteConfig\\":[{\\"name\\":\\"First Config\\",\\"value\\":2}]}"');

    expect(vi.mocked(jobManager.emit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jobManager.emit)).toHaveBeenCalledWith(
      "after-data-request",
      expect.objectContaining({})
    );
  });

  it("should not return data if the plan limit is reached", async () => {
    vi.mocked(EventService.getEventsForCurrentPeriod).mockResolvedValueOnce({
      events: 5,
      is80PercentOfLimit: false,
      plan: "PRO",
      planLimits: {
        eventsPerMonth: 1,
        environments: 100,
        flags: 100,
        tests: 100,
      },
    } satisfies Awaited<ReturnType<typeof EventService.getEventsForCurrentPeriod>>);

    const app = makeProjectDataRoute();

    const res = await testClient(app)[":projectId"]["script.js"].$get({
      param: {
        projectId: "test",
      },
      query: {
        environment: "test",
      },
    });
    expect(res.status).toBe(429);
    expect(trackPlanOverage).toHaveBeenCalledTimes(1);
  });
});
