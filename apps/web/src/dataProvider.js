import axios from "axios";

export const dataProvider = (apiUrl) => ({
  getList: async ({ resource, pagination }) => {
    const current = pagination?.current || 1;
    const pageSize = pagination?.pageSize || 20;
    const { data } = await axios.get(`${apiUrl}/${resource}`, { params: { current, pageSize } });
    return { data: data.data, total: data.total };
  },
  getOne: async ({ resource, id }) => {
    const { data } = await axios.get(`${apiUrl}/${resource}/${id}`);
    return { data: data.data };
  },
  create: async ({ resource, variables }) => {
    const { data } = await axios.post(`${apiUrl}/${resource}`, variables);
    return { data: data.data };
  },
  update: async ({ resource, id, variables }) => {
    const { data } = await axios.patch(`${apiUrl}/${resource}/${id}`, variables);
    return { data: data.data };
  },
  deleteOne: async ({ resource, id }) => {
    const { data } = await axios.delete(`${apiUrl}/${resource}/${id}`);
    return { data: data.data };
  },
  getApiUrl: () => apiUrl,
  custom: async ({ url, method, payload, query }) => {
    const { data } = await axios({ url: `${apiUrl}${url}`, method, data: payload, params: query });
    return { data };
  }
});
