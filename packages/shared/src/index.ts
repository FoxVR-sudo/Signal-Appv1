export type ReportCreateInput = {
  phone: string;
  photoUrl?: string;
  photoBase64?: string;
  lat: number;
  lng: number;
  gpsAccuracyM: number;
  capturedAtDevice: string;
};

export type ReportRecord = ReportCreateInput & {
  id: string;
  receivedAtServer: string;
  status: "submitted" | "assigned" | "accepted" | "closed";
};
