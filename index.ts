import * as pg from "npm:pg";
const { Pool } = pg.default;

// Getting config from config.json
const decoder = new TextDecoder("utf-8");
const file = await Deno.readFile("config.json");
const config: Config = JSON.parse(decoder.decode(file));

const makeRequest = async (
  url: string,
  headers: RequestConfig["headers"],
  params: RequestConfig["params"]
): Promise<number> => {
  // console.log(params)
  // Building request parameters
  url =
    "https://" +
    url +
    "/v1/tenants/telemetry" +
    "?" +
    decodeURIComponent(new URLSearchParams(params).toString());

  const controller = new AbortController();

  // Setting 180 seconds timeout:
  setTimeout(() => controller.abort(), 180000);
  const config: RequestConfig = {
    method: "GET",
    headers,
    signal: controller.signal,
  };

  // Requesting host and rejecting promise if status is not 200
  const response = await fetch(url, config);
  // console.log(JSON.stringify(await response.json(), null, 4));
  if (response.ok) {
    return response.status;
  }

  return Promise.reject(response);
};

const measureResponseTime = async (
  url: string,
  headers: RequestConfig["headers"],
  params: RequestConfig["params"]
): Promise<number[]> => {
  const start = Date.now();
  // MAking request and handling error 
  const status = await makeRequest(url, headers, params).catch((reason) => {
    if (reason.status) {
      // The request was made and the server responded with a status code
      console.log(
        `Server ${url} responded with an error ${reason.status}: `,
        JSON.stringify(reason.statusText, null, 4)
      );

      return reason.status;
    } else if (reason.name == "AbortError") {
      // The request was made but no response was received
      console.log(`No response from server ${url}. ${reason.message}`);

      return 0;
    } else {
      // Something happened in setting up the request that triggered an Error
      console.log("Error while making request: ", reason.message);

      return 0;
    }
  });

  const end = Date.now();
  const result_time = end - start;

  return [status, result_time];
};

// Chunk native implementation
const chunk = (
  arr: string[],
  chunkSize = 1,
  cache: Array<string[]> = []
): Array<string[]> => {
  const tmp: string[] = [...arr];
  if (chunkSize <= 0) return cache;
  while (tmp.length) cache.push(tmp.splice(0, chunkSize));
  return cache;
};

// Checking if token is valid
const check_token = async (
  headers: RequestConfig["headers"]
): Promise<string> => {
  console.log("Checking if confing token is valid...");
  try {
    const is_auth = await fetch("https://api.rpcm.cloud//v1/auth/is_auth", {
      method: "POST",
      body: JSON.stringify({
        Authorization: `Bearer ${headers?.Authorization}`,
      }),
      headers: headers,
    });

    if (is_auth.ok) {
      const data = await is_auth.json();

      console.log(
        "OK. Making requests...",
        JSON.stringify(data.result, null, 4)
      );

      return config.auth;
    } else throw is_auth;
  } catch (error) {
    if (error.status) {
      // The request was made and the server responded with a status code
      console.log(
        `Server responded with ${error.status}. Token is not valid.\nGetting new token with password...`
      );
      try {
        const response = await fetch(
          "https://api.rpcm.cloud//v2/auth/sign_in",
          {
            method: "POST",
            headers: {
              "User-Agent": "Rpcm",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: JSON.stringify({
              email: config.login,
              password: config.password,
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();

          console.log("New token:", data.result[0]);
          config.auth = data.result[0];

          Deno.writeTextFileSync(
            "config.json",
            JSON.stringify(config, null, 4)
          );
          console.log("Config updated. Making requests...");

          return data.result[0];
        } else throw response;
      } catch (sign_in_error) {
        if (sign_in_error.status) {
          const data = await sign_in_error.json();

          console.log(
            `Server responded with ${sign_in_error.status}. Could not get new token: ${data.result[0]}`
          );
        } else {
          // Something happened in setting up the request that triggered an Error
          console.log("Error while making request: ", sign_in_error.message);
        }
        return config.auth;
      }
    } else {
      // Something happened in setting up the request that triggered an Error
      console.log("Error while making request: ", error.message);
      return config.auth;
    }
  }
};

const makeParallelRequests = async (
  urls: string[],
  headers: RequestConfig["headers"],
  params: RequestConfig["params"]
): Promise<ResultDict[]> => {
  const new_jwt_token = await check_token(headers);
  headers!.Authorization = `Bearer ${new_jwt_token}`;

  const chunks = chunk(urls, 10);

  const promises = chunks.map(async (chunk: string[]) => {
    const requests = chunk.map((url) =>
      measureResponseTime(url, headers, params)
    );

    const responseTimes = await Promise.all(requests);
    const data: ResultDict = {};
    chunk.forEach((url, index) => {
      data[url] = {
        responseTime: responseTimes[index][1],
        status: responseTimes[index][0],
        timestamp: new Date(),
      };
    });

    return data;
    // return chunk.map((url, index) => ({ [url]: { responseTime: responseTimes[index][1], status: responseTimes[index][0], timestamp: new Date() } }));
    // return chunk.map((url, index) => ({ url, responseTime: responseTimes[index][1], status: responseTimes[index][0], timestamp: new Date() }));
  });

  const results = await Promise.all(promises);

  return results.flat();
};

const writeToDB = async (
  server: string,
  responseTime: number,
  status: number,
  timestamp: Date
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.results (
      id SERIAL PRIMARY KEY, 
      host INET NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL, 
      response_time INTEGER NOT NULL, 
      status_code INTEGER NOT NULL
      )
    `);
    await client.query(
      `
      INSERT INTO results (host, timestamp, response_time, status_code)
      VALUES ($1, $2, $3, $4)
    `,
      [server, timestamp, responseTime, status]
    );
    await client.query("COMMIT");
    console.log(`${server}: successfully written to DB`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.log("Error occurred while writing to DB.", e);
  } finally {
    client.release();
  }
};

const hosts: string[] = config.hosts;

const JWT_TOKEN: string = config.auth;
const headers = {
  Authorization: `Bearer ${JWT_TOKEN}`,
  "X-Forwarded-Host": "api.rpcm.cloud",
};

const pool = new Pool({
  user: config.database.user,
  host: config.database.host,
  database: config.database.database,
  password: config.database.password,
  port: config.database.port,
});

const params = {
  start_date:
    new Date(new Date().setDate(new Date().getDate() - config.days_delta))
      .toISOString()
      .slice(0, 19)
      .replace(/-/g, "-")
      .replace("T", "+") + "+%2B03:00",
  end_date:
    new Date().toISOString().slice(0, 19).replace(/-/g, "-").replace("T", "+") +
    "+%2B03:00",
};

interface ResultDict {
  [url: string]: {
    responseTime: number;
    status: number;
    timestamp: Date;
  };
}

interface Config {
  database: {
    user: string;
    password: string;
    host: string;
    database: string;
    port: number;
  };
  auth: string;
  hosts: string[];
  days_delta: number;
  login: string;
  password: string;
}

interface RequestConfig {
  url?: string;
  method: string;
  headers: {
    Authorization: string;
    "X-Forwarded-Host": string;
  };
  signal: AbortSignal;
  params?: {
    start_date: string;
    end_date: string;
  };
}

await makeParallelRequests(hosts, headers, params)
  .then(async (results) => {
    console.log(results);
    for (const [key, value] of Object.entries(results[0])) {
      await writeToDB(
        key,
        value["responseTime"],
        value["status"],
        value["timestamp"]
      );
    }
    Deno.exit();
  })
  .catch((error) => {
    console.error(error);
  });



