import type { events } from 'fetch-event-stream'

import { loader } from '.'
import { normalizeRequestTimeout, type ResponseType } from './httpGuards'

export class RequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = '请求错误'
  }
}
export type OnStream = (reader: ReturnType<typeof events>) => Promise<void>

/** 底层是原生 fetch，字段与其对应。 */
interface RequestOptions<TResponseType extends ResponseType> {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string | URLSearchParams | FormData | ArrayBuffer | Blob | DataView | ReadableStream
  timeout?: number
  /** @default 'text' */
  responseType?: TResponseType
}

export type RequestArgs<TResponseType extends ResponseType> = Partial<
  RequestOptions<TResponseType> & {
    onStream: OnStream
    isBackground: boolean
  }
>

export async function request<TResponseType extends ResponseType = 'json'>(
  args: RequestArgs<TResponseType>,
) {
  const {
    method = 'POST',
    url = '',
    data,
    headers = {},
    timeout: rawTimeout = 180,
    responseType = 'json' as TResponseType,
  } = args
  const timeout = normalizeRequestTimeout(rawTimeout)

  const signal = AbortSignal.timeout(timeout * 1000)
  return new Promise((resolve, reject) => {
    const axiosLoad = loader({ ms: timeout * 1000, color: '#7fa8ff' })

    const requestData = {
      method,
      headers,
      body: data,
      referrerPolicy: 'no-referrer',
    } as RequestInit

    fetch(url, { ...requestData, signal })
      .then(async (response) => {
        if (!response.body) {
          reject(new RequestError('没有响应体'))
          return
        }
        if (!response.ok || response.status >= 400) {
          const errorText = await response.text()
          reject(
            new RequestError(`状态码: ${response.status}: ${errorText} | ${response.statusText}`),
          )
          return
        }

        const result = responseType === 'json' ? await response.json() : await response.text()

        resolve(result)
      })
      .catch((e) => {
        if (e.name === 'AbortError') {
          reject(new RequestError('用户中止'))
        } else {
          const msg = `${e.message}`
          reject(new RequestError(msg))
        }
      })
      .finally(() => {
        axiosLoad()
      })
  })
}

request.post = async <TResponseType extends ResponseType = 'json'>(
  args: Omit<RequestArgs<TResponseType>, 'method'>,
) => {
  return request<TResponseType>({
    method: 'POST',
    ...args,
  })
}

request.get = async <TResponseType extends ResponseType = 'json'>(
  args: Omit<RequestArgs<TResponseType>, 'method'>,
) => {
  return request<TResponseType>({
    method: 'GET',
    ...args,
  })
}
