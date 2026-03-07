import axios, { AxiosRequestConfig } from 'axios';
import { prepareArgsForRequest, MappingResult } from './parameterMapper';
// import { recordToolCall } from 'elasticdash-test';

export interface FanOutRequest {
  needsFanOut: true;
  fanOutParam: string;
  fanOutValues: any[];
  baseSchema: any;
  mappedParams: Record<string, any>;
}

/**
 * Dynamically constructs and sends an API request based on the provided schema.
 *
 * 新增功能：
 * - 自动参数映射（team_ids -> id）
 * - Fan-out 检测（标量参数收到数组 -> 返回 FanOutRequest）
 *
 * @param {string} baseUrl - The base URL of the API.
 * @param {object} schema - The API schema containing path, method, and requestBody details.
 * @param {string} userToken - Optional user authentication token (Bearer token).
 * @returns {Promise<any | FanOutRequest>} - The API response, or FanOutRequest if fan-out is needed.
 */
export async function dynamicApiRequest(baseUrl: string, schema: any, userToken?: string): Promise<any> {
  try {
    console.log('Dynamic API Request Schema:', schema);
    const { path, method, requestBody, parameters, input } = schema;

    // Use user token if provided, otherwise fall back to environment token
    // Ensure token has "Bearer " prefix
    let token = '';
    if (userToken) {
      token = userToken.startsWith('Bearer ') ? userToken : `Bearer ${userToken}`;
      console.log('Using user token from localStorage for API authentication');
    } else if (process.env.NEXT_PUBLIC_ELASTICDASH_TOKEN) {
      token = `Bearer ${process.env.NEXT_PUBLIC_ELASTICDASH_TOKEN}`;
      console.log('Using environment token for API authentication (no user token provided)');
    } else {
      console.log('No authentication token available');
    }

    // ==================== 参数映射 ====================
    // 将模型提供的参数（可能 key 不匹配）映射到 API 要求的参数
    const providedArgs = parameters || input || {};
    let mappingResult: MappingResult | null = null;
    let pathParams = providedArgs; // 默认使用原始参数

    // 如果 schema 包含 parameters 定义（OpenAPI 格式），进行映射
    if (schema.parametersSchema || schema.apiParameters) {
      const apiParameters = schema.parametersSchema || schema.apiParameters;
      mappingResult = prepareArgsForRequest(path, apiParameters, providedArgs);
      pathParams = mappingResult.mapped;

      // 检测类型不匹配
      if (mappingResult.typeMismatchDetected) {
        const msg = `❌ 参数类型不匹配: ${mappingResult.typeMismatchDetail?.join("; ")}`;
        console.warn(msg);
        throw new Error(msg);
      }

      // 检测 fan-out：路径参数要求标量，但收到数组
      if (mappingResult.fanOutDetected && mappingResult.fanOutParam && mappingResult.fanOutValues) {
        console.log(`🔄 检测到 fan-out 需求，返回 FanOutRequest`);
        // recordToolCall('fanOutDetection', [baseUrl, schema, userToken], {
        //   needsFanOut: true,
        //   fanOutParam: mappingResult.fanOutParam,
        //   fanOutValues: mappingResult.fanOutValues,
        //   baseSchema: schema,
        //   mappedParams: pathParams,
        // });
        return {
          needsFanOut: true,
          fanOutParam: mappingResult.fanOutParam,
          fanOutValues: mappingResult.fanOutValues,
          baseSchema: schema,
          mappedParams: pathParams,
        } as FanOutRequest;
      }
    } else {
      console.log('⚠️  Schema 未提供 parametersSchema，跳过参数映射');
    }

    // Replace path parameters like {id} with actual values
    let finalPath = path;

    console.log('Path parameter replacement:');
    console.log('  - Original path:', path);
    console.log('  - Original parameters:', JSON.stringify(providedArgs));
    console.log('  - Mapped pathParams:', JSON.stringify(pathParams));
    if (mappingResult) {
      console.log('  - Mapping:', JSON.stringify(mappingResult.mapping));
    }

    if (pathParams && typeof pathParams === 'object') {
      Object.entries(pathParams).forEach(([key, value]) => {
        const placeholder = `{${key}}`;
        if (finalPath.includes(placeholder)) {
          finalPath = finalPath.replace(placeholder, String(value));
          console.log(`  ✅ Replaced ${placeholder} with ${value} in path`);
        }
      });
    }

    console.log('  - Final path:', finalPath);

    // Configure the request
    const config: AxiosRequestConfig = {
      method: method.toLowerCase(),
      url: `${baseUrl}${finalPath}`,
      data: requestBody ? requestBody : undefined,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
    };

    console.log('Dynamic API Request Config:', JSON.stringify(config, null, 2))

    // Send the request
    const response = await axios(config);

    // recordToolCall('fanOutDetection', [baseUrl, schema, userToken], response.data);
    return response.data;
  } catch (error) {
    console.error('Error in dynamicApiRequest:', error);
    throw error;
  }
}