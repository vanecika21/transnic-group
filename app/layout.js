export const metadata = {
  title: "Taxi Fleet Pro",
  description: "Gestionare flotă de taxi — mașini, șoferi, calendar de sdare, finanțe",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ro">
      <body style={{ margin: 0, background: "#14171c" }}>{children}</body>
    </html>
  );
}
